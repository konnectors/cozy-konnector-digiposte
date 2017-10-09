export const getFileName = (doc) => {
  let result = null

  if (doc.invoice) {
    // a lot of invoices have the name Facture.pdf. I try to construct a more meaningfull and
    // unique name with invoice information
    let date = new Date(doc.invoice_data.due_on)
    date = date.toLocaleDateString()
    result = `Facture_${date}_${doc.invoice_data.chargeable_amount}${doc.invoice_data.currency}.pdf`
  } else {
    result = doc.filename
  }
  return result
}
