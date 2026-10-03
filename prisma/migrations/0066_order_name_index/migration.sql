-- History joins each scan to its order by name, to show what the courier said
-- about a parcel beside when the bench actually saw it. That is an IN over the
-- page's 500 order names, and (shop, orderName) had no index — orderId was
-- unique, orderName was not indexed at all.
--
-- Not CONCURRENTLY: Prisma runs a migration inside a transaction, where that
-- form is rejected outright. This takes a brief write lock instead, which only
-- the delivery sync would ever contend with.
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_orderName_idx"
  ON "OrderFinancials" ("shop", "orderName");
