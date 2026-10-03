# Tracking script (Google Apps Script)

The AWB tracker behind the delivery sheet. It does not run from this repo —
it lives in Apps Script and is pulled/pushed with clasp:

    npx clasp login                     # once, interactive
    echo '{"scriptId":"<ID>"}' > .clasp.json
    npx clasp pull
    npx clasp push --force

Script ID: `1Fa4DzwY_JZWbbAWEg4R_IAeuiiA_9K6DCsG0v1qXHSChPZk5m10s64VO`

A copy is kept here so changes are reviewable in git. It is a COPY: the
running version is whatever was last pushed, so pull before editing.

## Why RTO dates were never captured

Delhivery's last scan reports a bare code — `Scan: "RTO"` — with no word
meaning "arrived". `isArrivalStatus` tested for `delivered` or `returned to
seller`, so it returned false and the date was dropped, even though
`ScanDateTime` was in the same object.

`isFinalStatus` then treated bare `'rto'` as final, so later passes skipped
the row and the date could never be filled. One function called it finished;
the other would not accept it as arrived.

The arrival is in the fields beside the code: `ScanType "DL"` is the handover
(an RTO still moving reads `"RT"`), and `Instructions` reads `"RETURN
Accepted"`. Measured on 80 parcels physically received: the old rule dated 0,
the new rule dates 78.

`DTO` is deliberately NOT folded into RTO. It is a parcel the courier
collected FROM the customer (`OrderType: "Pickup"`) — a customer return, not
a courier RTO. Of 1709 scans audited, 45 were filed against the wrong
counterparty on exactly this distinction.
