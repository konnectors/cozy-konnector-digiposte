process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://f6f64db44c394bb3856d0198732634bf@sentry.cozycloud.cc/95'

const {
  BaseKonnector,
  log,
  saveFiles,
  cozyClient,
  requestFactory,
  errors
} = require('cozy-konnector-libs')
const { getFileName } = require('./utils')
const fulltimeout = Date.now() + 4 * 60 * 1000
let request = requestFactory()
const j = request.jar()
request = requestFactory({
  cheerio: true,
  json: false,
  jar: j
})

let xsrfToken = null
let accessToken = null

module.exports = new BaseKonnector(fetchBills)

async function fetchBills(requiredFields) {
  let $ = await request('https://secure.digiposte.fr/identification-plus')
  // getting the login token in the login form
  const loginToken = $('#credentials_recover_account__token').val()
  if (loginToken === undefined) {
    throw new Error('Could not get the login token')
  }
  log('debug', `The login token is ${loginToken}`)
  // now posting login requestFactory
  $ = await request.post('https://secure.digiposte.fr/login_check', {
    qs: {
      isLoginPlus: 1
    },
    form: {
      'login_plus[userType]': 'part',
      'login_plus[login]': requiredFields.email,
      'login_plus[input]': requiredFields.password,
      'login_plus[registrationId]': '',
      'login_plus[trustedContactId]': '',
      'login_plus[tokenCustomization]': '',
      'login_plus[isLoginPlus]': 1,
      'login_plus[_token]': loginToken
    }
  })
  if ($('#infoQuestion').length) {
    log(
      'warn',
      $('.dgplusContainer')
        .text()
        .trim()
    )
    throw new Error(errors.USER_ACTION_NEEDED)
  }

  // read the XSRF-TOKEN in the cookie jar and add it in the header
  log('info', 'Getting the XSRF token')
  const xsrfcookie = j
    .getCookies('https://secure.digiposte.fr/login_check')
    .find(cookie => cookie.key === 'XSRF-TOKEN')

  // if no xsrf token is found, then we have bad credential
  if (xsrfcookie) {
    xsrfToken = xsrfcookie.value
    log('info', 'Successfully logged in')
  } else throw new Error('LOGIN_FAILED')

  xsrfToken = xsrfcookie.value
  log('debug', 'XSRF token is ' + xsrfToken)
  if (!xsrfcookie) throw new Error('Problem fetching the xsrf-token')

  // Now get the access token
  log('info', 'Getting the app access token')
  request = requestFactory({
    json: true,
    cheerio: false,
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
  } else throw new Error('Problem fetching the access token')

  // Now get the list of folders
  log('info', 'Getting the list of folders')
  request = request.defaults({
    auth: {
      bearer: accessToken
    }
  })

  body = await request('https://secure.digiposte.fr/api/v3/folders/safe')
  return fetchFolder(body, requiredFields.folderPath, fulltimeout, requiredFields.password)
}

// create a folder if it does not already exist
function mkdirp(path, folderName) {
  folderName = sanitizeFolderName(folderName)
  return cozyClient.files.statByPath(`${path}/${folderName}`).catch(err => {
    log('info', err.message, `${path} folder does not exist yet, creating it`)
    return cozyClient.files.statByPath(`${path}`).then(parentFolder =>
      cozyClient.files.createDirectory({
        name: folderName,
        dirID: parentFolder._id
      })
    )
  })
}

function sanitizeFolderName(foldername) {
  return foldername.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

async function fetchFolder(body, rootPath, timeout, password) {
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
    log('info', folder.name + '...')

    //* Trying to retreive Health-token with the user's password (to allow health documents to be downloadable)
    let healthToken
    await request({
      url: 'https://secure.digiposte.fr/rest/security/health-token',
      method: 'POST',
      headers: {
        'X-XSRF-TOKEN': xsrfToken
      },
      form: {
        "password": password //* need password again
      }
    }, (error, response, body) => {
      healthToken = JSON.parse(body).access_token
    })

    folder = await request.post(
      'https://secure.digiposte.fr/api/v3/documents/search',
      {
        headers: {
          'Authorization': `Bearer ${healthToken}` //* Need the new token here (health-token)
        },
        qs: {
          direction: 'DESCENDING',
          max_results: 100,
          sort: 'CREATION_DATE'
        },
        body: {
          folder_id: result.id,
          locations: ['SAFE', 'INBOX']
        }
      }
    )
    result.docs = folder.documents.map(doc => ({ 
      //* If you need : doc.health_document is a bool to know if the document is a health document or not
      docid: doc.id,
      type: doc.category,
      fileurl: `https://secure.digiposte.fr/rest/content/document?_xsrf_token=${xsrfToken}`,
      filename: getFileName(doc),
      vendor: doc.sender_name,
      requestOptions: {
        method: 'POST',
        jar: j,
        form: {
          'document_ids[]': doc.id
        }
      }
    }))
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
    if (folder.docs) {
      await saveFiles(folder.docs, `${rootPath}/${folder.name}`, {
        timeout: now + timeForThisFolder
      })
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
