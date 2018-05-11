/* eslint-env jest */
import { getFileName } from '../src/utils'

describe('getFileName', () => {
  it('inserts date into bill', () => {
    expect(
      getFileName({
        invoice: true,
        invoice_data: {
          chargeable_amount: '42',
          currency: '€',
          due_on: '2017-10-09T16:12:27.704Z'
        }
      })
    ).toMatchSnapshot()
  })

  it('inserts date into account situations', () => {
    expect(
      getFileName({
        filename: 'Relevé de compte.pdf',
        creation_date: '2017-10-09T16:12:27.704Z'
      })
    ).toMatchSnapshot()
  })

  it('inserts date into file with no extensions', () => {
    expect(
      getFileName({
        filename: 'Décidément rien ne va',
        creation_date: '2017-10-09T16:12:27.704Z'
      })
    ).toMatchSnapshot()
  })

  it('returns file name when no date', () => {
    expect(
      getFileName({
        filename: 'Relevé de compte.pdf'
      })
    ).toMatchSnapshot()
  })

  it('returns file name when incorrect date', () => {
    expect(
      getFileName({
        filename: 'Relevé de compte.pdf',
        creation_date: 'Oops not a date'
      })
    ).toMatchSnapshot()
  })
})
