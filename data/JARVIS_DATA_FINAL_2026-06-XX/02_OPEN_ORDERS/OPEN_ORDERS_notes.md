# Open Orders Notes



This folder is for sanitized open order and order history information.



The original order history spreadsheet is maintained by Chet in Microsoft Teams / Files.



The original spreadsheet may contain cost, pricing, or other internal information that should not be exposed to JARVIS users.



JARVIS should only use a sanitized version of the order history.



## What JARVIS May Answer



JARVIS may answer questions such as:



* Was this item ordered?

* Is there an open order for this part?

* What vendor was it ordered from?

* What PO number is associated with the order, if available?

* What is the expected delivery date, if available?

* Has the item been received, if the sanitized records show that?

* What is the latest known status?



## What JARVIS Must Not Expose



JARVIS must not expose:



* Cost

* Unit price

* Total price

* Vendor pricing details

* Accounting fields

* Internal approval notes

* Any confidential purchasing information



## Recommended Sanitized Columns



The sanitized open orders file should include only fields such as:



* Order Date

* Vendor

* Item Number / Part Number

* Description

* Machine / Area

* Quantity

* PO Number

* Quote Number, if safe

* Order Status

* Expected Delivery Date

* Received Date

* Notes

* Last Updated



## Freshness Rule



Open order data can change quickly.



If JARVIS answers from a snapshot, it should say:



"Based on the open orders snapshot last updated [date]..."



If JARVIS answers from the live sanitized export, it should say:



"Based on the latest sanitized open orders file..."



## Authority Rule



JARVIS may tell users what the records show.



JARVIS must not:



* Say an item was ordered unless the sanitized order records show it.

* Promise a delivery date unless the records show one.

* Approve purchases.

* Create purchase orders.

* Change order status.

* Contact vendors.



## If No Order Is Found



If JARVIS cannot find an order, it should say:



"I could not find that item in the current sanitized open orders data."



Then, if appropriate, JARVIS may suggest:



"If this needs to be ordered, follow the PO request process: fill out the PO Request Form, attach the quote that supports the price, and email both to [POR-Richmond@wearemoore.com](mailto:POR-Richmond@wearemoore.com)."



