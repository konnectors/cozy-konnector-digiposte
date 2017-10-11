'use strict'

const { BaseKonnector, log, saveFiles, cozyClient, request } = require('cozy-konnector-libs')
const { getFileName } = require('./utils')
const fulltimeout = Date.now() + 60 * 1000
const bb = require('bluebird')
let rq = request()
const j = rq.jar()
rq = request({
  cheerio: true,
  json: false,
  jar: j
})

let xsrfToken = null
let accessToken = null

module.exports = new BaseKonnector(function (fields) {
  return fetchBills(fields)
})

function fetchBills (requiredFields) {
  return rq('https://secure.digiposte.fr/identification-plus')
  .then($ => {
    // getting the login token in the login form
    const loginToken = $('#credentials_recover_account__token').val()
    if (loginToken === undefined) {
      throw new Error('Could not get the login token')
    }
    return loginToken
  })
  .then(loginToken => {
    log('info', `The login token is ${loginToken}`)
    // now posting login request
    rq = request()
    return rq({
      uri: 'https://secure.digiposte.fr/login_check',
      qs: {
        isLoginPlus: 1
      },
      method: 'POST',
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
  })
  .then(() => {
    // read the XSRF-TOKEN in the cookie jar and add it in the header
    log('info', 'Getting the XSRF token')
    const xsrfcookie = j.getCookies('https://secure.digiposte.fr/login_check')
      .find(cookie => cookie.key === 'XSRF-TOKEN')

    // if no xsrf token is found, then we have bad credential
    if (xsrfcookie) {
      xsrfToken = xsrfcookie.value
    } else throw new Error('LOGIN_FAILED')

    xsrfToken = xsrfcookie.value
    log('info', 'XSRF token is ' + xsrfToken)
    if (xsrfcookie) return xsrfToken
    else throw new Error('Problem fetching the xsrf-token')
  })
  .then(() => {
    // Now get the access token
    log('info', 'Getting the app access token')
    rq = rq.defaults({
      headers: {
        'X-XSRF-TOKEN': xsrfToken
      }
    })
    return rq('https://secure.digiposte.fr/rest/security/tokens')
  })
  .then(body => {
    if (body && body.access_token) {
      accessToken = body.access_token
      return accessToken
    } else throw new Error('Problem fetching the access token')
  })
  .then(() => {
    // Now get the list of folders
    log('info', 'Getting the list of folders')
    rq = rq.defaults({
      auth: {
        bearer: accessToken
      }
    })
    return rq('https://secure.digiposte.fr/api/v3/folders/safe')
  })
  .then(body => fetchFolder(body, requiredFields.folderPath, fulltimeout))
}

// create a folder if it does not already exist
function mkdirp (path, folderName) {
  folderName = sanitizeFolderName(folderName)
  return cozyClient.files.statByPath(`${path}/${folderName}`)
  .catch(err => {
    log('info', err.message, `${path} folder does not exist yet, creating it`)
    return cozyClient.files.statByPath(`${path}`)
    .then(parentFolder => cozyClient.files.createDirectory({name: folderName, dirID: parentFolder._id}))
  })
}

function sanitizeFolderName (foldername) {
  return foldername.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

function fetchFolder (body, rootPath, timeout) {
  // Then, for each folder, get the logo, list of files : name, url, amount, date
  body.folders = body.folders || []
  let foldernames = body.folders.map(folder => folder.name)
  log('debug', foldernames, 'List of folders')
  log('info', 'Getting the list of documents for each folder')

  // If this is the root folder, also fetch it's documents
  if (!body.name) body.folders.unshift({ id: '', name: '' })

  return bb.mapSeries(body.folders, folder => {
    let result = {
      id: folder.id,
      name: folder.name,
      folders: folder.folders
    }
    log('info', folder.name + '...')
    return rq({
      uri: 'https://secure.digiposte.fr/api/v3/documents/search',
      qs: {
        direction: 'DESCENDING',
        max_results: 100,
        sort: 'CREATION_DATE'
      },
      body: {
        folder_id: result.id,
        locations: ['SAFE', 'INBOX']
      },
      method: 'POST'
    })
    .then(folder => {
      result.docs = folder.documents.map(doc => ({
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
      log('info', '' + result.docs.length + ' document(s)')
      return result
    })
  })
  .then(folders => {
    return bb.each(folders, (folder, index, length) => {
      const remainingTime = timeout - Date.now()
      const timeForThisFolder = remainingTime / (length - index)
      log('info', 'Getting vendor ' + folder.name)
      return mkdirp(rootPath, folder.name)
      .then(() => saveFiles(folder.docs, `${rootPath}/${folder.name}`, {
        timeout: Date.now() + timeForThisFolder
      }))
      .then(() => {
        if (folder.name !== '') {
          return fetchFolder(folder, `${rootPath}/${sanitizeFolderName(folder.name)}`, Date.now() + timeForThisFolder)
        }
      })
    })
  })
}
