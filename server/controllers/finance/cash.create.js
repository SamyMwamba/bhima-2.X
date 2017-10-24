
const uuid = require('node-uuid');
const _ = require('lodash');
const db = require('../../lib/db');
const BadRequest = require('../../lib/errors/BadRequest');
const util = require('../../lib/util');
const Topic = require('../../lib/topic');

module.exports = create;

/**
 * @function processCashItems
 *
 * @description
 * This method prepares the cash items for writing to the DB.  It ensures that
 * the uuids are defined and converted, and that each item represents an ordered
 * array of values.
 *
 * @param {Buffer} cashUuid - the binary uuid of the cash record
 * @param {Array} items - an array of cash_item JSONs
 * @returns {Array} - an ordered array of arrays (cash_items)
 */
function processCashItems(cashUuid, items) {
  // make sure uuids are defined and converted

  items.map((item) => {
    item.cash_uuid = cashUuid;
    item.uuid = item.uuid || uuid.v4();
    return db.convert(item, ['uuid', 'invoice_uuid']);
  });

  // make sure the items are in an ordered array
  const order = util.take('uuid', 'cash_uuid', 'invoice_uuid');
  return _.map(items, order);
}

/**
 * @method processCash
 *
 * @description
 * Turns the cash payment into an array of values for templating into MySQL.
 *
 *
 */
function processCash(cashUuid, cashPayment) {
  let payment = cashPayment;

  payment.uuid = cashUuid;
  payment = db.convert(payment, ['debtor_uuid']);

  if (payment.date) {
    payment.date = new Date(payment.date);
  }

  // remove the cash items so that the SQL query is properly formatted
  delete payment.items;

  // turns the object into an array ordered by these values
  const order = util.take(
    'amount', 'currency_id', 'cashbox_id', 'debtor_uuid', 'project_id', 'date',
    'user_id', 'is_caution', 'description', 'uuid'
  );

  return order(payment);
}

/**
 * @method create
 *
 * @description
 * Creates a cash payment against one or many previous invoices or a cautionary
 * payment.  If a UUID is not provided, one is automatically generated by the
 * server process.
 *
 *
 * POST /cash
 */
function create(req, res, next) {
  // alias insertion data
  let data = req.body.payment;
  const isInvoicePayment = !data.is_caution;
  const hasItems = (data.items && data.items.length > 0);

  // disallow invoice payments with empty items by returning a 400 to the client
  if (isInvoicePayment && !hasItems) {
    next(
      new BadRequest('You must submit cash items with the payments against previous invoices.')
    );

    return;
  // disallow caution payments with items for more predictable application
  // behavior.
  } else if (!isInvoicePayment && hasItems) {
    next(
      new BadRequest(
        `You must be confused. You submitted payment against items marked as a
        caution payment.  Please submit either a caution with no items or a payment
        marked with is_caution = 0.`
      )
    );

    return;
  }

  // generate a UUID if it not provided.
  const cashUuid = db.bid(data.uuid || uuid.v4());

  // trust the server's session info over the client's
  data.project_id = req.session.project.id;
  data.user_id = req.session.user.id;

  let items;

  // if items exist, transform them into an array of arrays for db formatting
  if (data.items) {
    items = processCashItems(cashUuid, data.items);
  }

  data = processCash(cashUuid, data);

  /*
   * Begins posting process
   *
   * If this looks weird, it is to try and have a single level of stored procedures.
   * Having nested stored procedures reduces guarantees on the
   */

  const transaction = db.transaction();

  // proposed posting process
  transaction.addQuery('CALL StageCash(?)', [data]); // @todo - rename data -> payment

  if (isInvoicePayment) {
    items.forEach(item => transaction.addQuery('CALL StageCashItem(?)', [item]));
    transaction.addQuery('CALL CalculateCashInvoiceBalances(?)', [cashUuid]);
  }

  transaction.addQuery('CALL WriteCash(?)', [cashUuid]);

  if (isInvoicePayment) {
    transaction.addQuery('CALL WriteCashItems(?)', [cashUuid]);
  }

  // finally run the posting script.
  transaction.addQuery('CALL PostCash(?)', [cashUuid]);

  transaction.execute()
    .then(() => {
      res.status(201).json({ uuid : uuid.unparse(cashUuid) });

      Topic.publish(Topic.channels.FINANCE, {
        event   : Topic.events.CREATE,
        entity  : Topic.entities.PAYMENT,
        user_id : req.session.user.id,
        user    : req.session.user.display_name,
        uuid    : uuid.unparse(cashUuid),
      });
    })
    .catch(next)
    .done();
}

