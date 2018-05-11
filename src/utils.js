const { format } = require('date-fns')

const fileDateFormat = date => format(date, 'YYYY-MM-D')

const getFileName = doc => {
  if (doc.invoice) {
    // a lot of invoices have the name Facture.pdf. I try to construct a more meaningfull and
    // unique name with invoice information
    const date = new Date(doc.invoice_data.due_on)
    return `Facture_${fileDateFormat(date)}_${
      doc.invoice_data.chargeable_amount
    }${doc.invoice_data.currency}.pdf`
  }

  // Every file seems to have the same name, so let's try to add the creation
  // date to every one of them.
  if (!doc['creation_date']) {
    return doc.filename
  }

  const creationDate = new Date(doc['creation_date'])
  const isValidDate = !isNaN(creationDate.getTime())

  if (!isValidDate) {
    return doc.filename
  }

  return doc.filename
    .split('.')
    .reduce((accumulator, fragment, index, fragments) => {
      const hasNoFileExtension = fragments.length === 1
      if (hasNoFileExtension) {
        return `${fragment}_${fileDateFormat(creationDate)}`
      }

      const isFileExtension = index === fragments.length - 1
      if (isFileExtension) {
        return `${accumulator}_${fileDateFormat(creationDate)}.${fragment}`
      }

      return `${accumulator}${index ? '.' : ''}${fragment}`
    }, '')
}

module.exports = {
  getFileName: getFileName
}
