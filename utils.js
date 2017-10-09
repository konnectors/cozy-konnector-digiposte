export const getFileName = (doc) => {
  if (doc.invoice) {
    // a lot of invoices have the name Facture.pdf. I try to construct a more meaningfull and
    // unique name with invoice information
    const date = new Date(doc.invoice_data.due_on)
    return `Facture_${date.toLocaleDateString()}_${doc.invoice_data.chargeable_amount}${doc.invoice_data.currency}.pdf`
  }
  return doc.filename
}
