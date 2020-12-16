process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://f6f64db44c394bb3856d0198732634bf@sentry.cozycloud.cc/95'

const {
  BaseKonnector,
  log,
  saveFiles,
  cozyClient,
  requestFactory,
  errors,
  solveCaptcha
} = require('cozy-konnector-libs')
const { getFileName } = require('./utils')
const fulltimeout = Date.now() + 4 * 60 * 1000
let request = requestFactory()
const j = request.jar()
request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: j
})

let xsrfToken = null
let accessToken = null
let healthToken = null

let sourceAccount, sourceAccountIdentifier

module.exports = new BaseKonnector(fetch)

async function fetch(requiredFields) {
  sourceAccount = this._account._id
  sourceAccountIdentifier = requiredFields.email
  // Login and fetch multiples tokens
  await login.bind(this)(requiredFields)
  await fetchTokens(requiredFields.password)
  request = request.defaults({
    auth: {
      bearer: accessToken
    }
  })
  // Now get the list of folders
  log('info', 'Getting the list of folders')
  const folders = await request('https://api.digiposte.fr/api/v3/folders')
  return fetchFolder(folders, requiredFields.folderPath, fulltimeout)
}

async function login(fields) {
  await this.deactivateAutoSuccessfulLogin()
  const respInit = await request.get({
    uri: 'https://secure.digiposte.fr/identification-plus',
    resolveWithFullResponse: true
  })
  const state = respInit.request.href.match(/state=([0-9a-z-]*)/)[1]
  const codeChallenge = respInit.request.href.match(/code_challenge=(.*?)&/)[1]
  // We set a fix fingerprint here
  await request.get({
    uri: `https://auth.digiposte.fr/signin?client_id=ihm_abonne&code_challenge=${codeChallenge}&redirect_uri=https%3A%2F%2Fsecure.digiposte.fr%2Fcallback&state=${state}&fingerprint=e804c8efde877a0925c9e3a7d5a98e15`
  })

  const secureToken = await solveCaptcha({
    type: 'hcaptcha',
    websiteKey: '0caa33b7-a445-43e4-a258-5affe1597c49',
    websiteURL: 'https://compte.laposte.fr/fo/v1/login?captcha=1'
  })

  const response = await request.post('https://compte.laposte.fr/v2/signin', {
    form: {
      'g-recaptcha-response': secureToken,
      'h-captcha-response': secureToken,
      user_type: 'PART',
      _username: fields.email,
      _password: fields.password
    },
    resolveWithFullResponse: true
  })

  if (response.request.uri.href === 'https://compte.laposte.fr/fo/v1/login' ||
     response.request.uri.href === 'https://compte.laposte.fr/fo/v1/login?captcha=1') {
    throw new Error(errors.LOGIN_FAILED)
  } else if (response.request.uri.href === 'https://secure.digiposte.fr/') {
    await this.notifySuccessfulLogin()
    return true
  } else if (
    response.request.uri.href === 'https://secure.digiposte.fr/question-secret'
  ) {
    throw new Error(errors.USER_ACTION_NEEDED_CGU_FORM)
  } else if (
    response.request.uri.href === 'https://compte.laposte.fr/fo/v1/checkpoint'
  ) {
    await handle2FA.bind(this)()
    await this.notifySuccessfulLogin()
  } else {
    log(
      'error',
      `Wrong resulting url after login: ${response.request.uri.href}`
    )
    throw new Error(errors.VENDOR_DOWN)
  }
}

// Read the XSRF-TOKEN in the cookie jar and set it globably
async function extractXsrfToken() {
  log('info', 'Getting the XSRF token for cookie jar')
  let xsrfcookie = j
    .getCookies('https://secure.digiposte.fr/')
    .find(cookie => cookie.key === 'XSRF-TOKEN')

  if (!xsrfcookie) {
    log('error', 'Problem fetching the xsrf-token')
    throw new Error(errors.VENDOR_DOWN)
  }
  xsrfToken = xsrfcookie.value
  log('debug', 'XSRF token is set to ' + xsrfToken)
}

async function fetchTokens(password) {
  // Extract a first Xsrf
  extractXsrfToken()

  // Get the access token
  log('info', 'Getting the app access token')
  request = requestFactory({
    cheerio: false,
    json: true,
    jar: j
  })
  request = request.defaults({
    headers: {
      'X-XSRF-TOKEN': xsrfToken
    }
  })
  let body = await request('https://secure.digiposte.fr/rest/security/tokens')
  if (body && body.access_token) {
    accessToken = body.access_token
  } else {
    log('error', 'Problem fetching the access token')
    throw new Error(errors.VENDOR_DOWN)
  }

  // Requesting healthToken with password
  log('info', `Getting the health-token`)
  await request(
    {
      url: 'https://secure.digiposte.fr/rest/security/health-token',
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*'
      },
      json: {
        password: password // need password again here
      }
    },
    (error, response, body) => {
      healthToken = body.access_token
    }
  )

  // Extract a second Xsrf as it changed
  extractXsrfToken()
  // eslint-disable-next-line require-atomic-updates
  request = request.defaults({
    headers: {
      'X-XSRF-TOKEN': xsrfToken
    }
  })
}

async function handle2FA() {
  const code = await this.waitForTwoFaCode({
    type: 'sms'
  })
  const response = await request.post('https://compte.laposte.fr/v2/2fa', {
    form: { code },
    resolveWithFullResponse: true
  })
  if (response.request.uri.href === 'https://secure.digiposte.fr/') {
    return true
  } else {
    throw new Error('LOGIN_FAILED.WRONG_TWOFA_CODE')
  }
}

// create a folder if it does not already exist
function mkdirp(path, folderNameInput) {
  const folderName = sanitizeFolderName(folderNameInput)
  return cozyClient.files.statByPath(`${path}/${folderName}`).catch(err => {
    log('info', err.message, `${path} folder does not exist yet, creating it`)
    return cozyClient.files
      .statByPath(`${path}`)
      .then(parentFolder =>
        cozyClient.files.createDirectory({
          name: folderName,
          dirID: parentFolder._id
        })
      )
      .catch(err => {
        if (err.status !== 409) {
          throw err
        }
      })
  })
}

function sanitizeFolderName(foldername) {
  return foldername.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

async function fetchFolder(body, rootPath, timeout) {
  // Then, for each folder, get the logo, list of files : name, url, amount, date
  body.folders = body.folders || []
  log('info', 'Getting the list of documents for each folder')
  log('info', `TIMEOUT in ${Math.floor((timeout - Date.now()) / 1000)}s`)

  // If this is the root folder, also fetch it's documents
  if (!body.name) body.folders.unshift({ id: '', name: '' })

  let folders = []
  for (let folder of body.folders) {
    let result = {
      id: folder.id,
      name: folder.name,
      folders: folder.folders
    }
    log('debug', 'Fetching files in folder : ' + (folder.name || 'root_dir') + '...')
    folder = await request.post(
      'https://api.digiposte.fr/api/v3/documents/search',
      {
        headers: {
          Authorization: `Bearer ${healthToken}` //* Need the health-token here
        },
        qs: {
          direction: 'DESCENDING',
          max_results: 1000,
          sort: 'CREATION_DATE'
        },
        body: {
          folder_id: result.id,
          locations: ['SAFE', 'INBOX']
        }
      }
    )
    result.docs = folder.documents.map(doc => {
      let tmpDoc = {
        docid: doc.id,
        type: doc.category,
        fileurl: `https://secure.digiposte.fr/rest/content/document`,
        filename: getFileName(doc),
        vendor: doc.sender_name,
        requestOptions: {
          method: 'POST',
          jar: j,
          form: {
            'document_ids[]': doc.id
          },
          headers: {
            'X-XSRF-TOKEN': xsrfToken
          }
        }
      }

      // Orange payslip specific
      if (doc.category === 'Bulletin de paie' && doc.author_name === 'Orange') {
        const creationDateObj = new Date(doc.creation_date)
        const nextMonthObj = new Date(
          Date.UTC(
            creationDateObj.getFullYear(),
            creationDateObj.getMonth() + 1,
            1
          )
        ) // First day of next month
        const lastDayObj = new Date(
          Date.UTC(nextMonthObj.getFullYear(), nextMonthObj.getMonth())
        )
        lastDayObj.setDate(0) // Set day before the first day of next month
        // First day of the month
        const firstDayStg = new Date(
          Date.UTC(creationDateObj.getFullYear(), creationDateObj.getMonth(), 1)
        ).toISOString()

        tmpDoc.fileAttributes = {
          metadata: {
            classification: 'payslip',
            datetime: firstDayStg,
            datetimeLabel: 'startDate',
            contentAuthor: 'orange',
            startDate: firstDayStg,
            endDate: lastDayObj.toISOString(),
            issueDate: doc.creation_date
          }
        }
      }
      return tmpDoc
    })
    if (result && result.docs) {
      log('info', '' + result.docs.length + ' document(s)')
    }
    folders.push(result)
  }

  // sort the folders by the number of documents
  folders.sort((a, b) => {
    return a.docs.length > b.docs.length ? 1 : -1
  })

  let index = 0
  for (let folder of folders) {
    const now = Date.now()
    const remainingTime = timeout - now
    const timeForThisFolder = remainingTime / (folders.length - index)
    index++
    log('info', 'Getting vendor ' + folder.name)
    log('info', `Remaining time : ${Math.floor(remainingTime / 1000)}s`)
    log(
      'info',
      `Time for this folder : ${Math.floor(timeForThisFolder / 1000)}s`
    )
    await mkdirp(rootPath, folder.name)
    if (folder.docs && folder.docs.length > 0) {
      await saveFiles(
        folder.docs,
        `${rootPath}/${sanitizeFolderName(folder.name)}`,
        {
          timeout: now + timeForThisFolder,
          sourceAccount,
          sourceAccountIdentifier,
          fileIdAttributes: ['docid'],
          concurrency: 4
        }
      )
    }

    if (folder.name !== '') {
      await fetchFolder(
        folder,
        `${rootPath}/${sanitizeFolderName(folder.name)}`,
        now + timeForThisFolder
      )
    }
  }
}
