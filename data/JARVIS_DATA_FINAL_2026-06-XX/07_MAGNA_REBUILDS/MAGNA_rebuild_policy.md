# Magna Rebuild Policy



This file tells JARVIS how to answer questions about W+D motors and drives currently at Magna.



Magna diagnoses, rebuilds, and restores motors and drives for the W+D envelope machines.



This process can be expensive and can take significant time.



JARVIS may summarize approved information from the Magna rebuild spreadsheet, but JARVIS must not decide repair priority, approve repairs, or say a repair has been authorized unless the approved records clearly show that.



## Source Spreadsheet



Use the sanitized Magna rebuild spreadsheet in this folder:



`MAGNA_motor_drive_rebuilds_sanitized_2026-06-XX.xlsx`



The spreadsheet may include motors and drives that have been sent to Magna for diagnosis, quoting, repair, rebuild, or return.



## General Background



Several W+D motors and drives have been sent to Magna over the last several months or year.



Jonathan’s notes say Gerard’s guidance is:



* The motors and drives are all needed.

* There is no strict priority order.

* We do not know which one may be needed next for a future repair.

* The current practical plan is to repair about one motor and one drive per month and return them to inventory.



## What JARVIS May Answer



JARVIS may answer questions such as:



* What motors are currently at Magna?

* What drives are currently at Magna?

* What quote number is associated with an item?

* What is the listed issue or fault?

* Has a PO been sent, if the sanitized file clearly shows that?

* Is the item listed as quoted, approved, in repair, shipped back, or received?

* What is the general monthly repair plan?

* Which items appear to still need review?



## What JARVIS Must Not Do



JARVIS must not:



* Approve a repair.

* Choose which motor or drive should be repaired next.

* Say a PO should be sent for a specific item unless approved notes clearly say that.

* Say a repair is authorized unless the approved records clearly show it.

* Say something has been shipped or received unless the approved records clearly show it.

* Expose repair cost, unit cost, total cost, or private quote pricing.

* Contact Magna.

* Promise return dates.



## Cost / Pricing Privacy



The JARVIS-safe version of the Magna spreadsheet should not expose repair cost, unit price, total price, or private quote pricing.



If cost information exists in the original file, it should be removed from the sanitized JARVIS version.



JARVIS should not mention repair cost unless Jonathan specifically approves that field for JARVIS use.



## Recommended Sanitized Columns



The sanitized Magna rebuild file should include fields such as:



* Item Type

* Motor / Drive ID

* Manufacturer / Model

* Serial Number

* Machine / Area, if known

* Quote Number

* Date Sent to Magna

* Quote Date

* Issue / Fault

* Required Work

* Lead Time

* Status

* PO Status

* Received Status

* Next Action

* Notes

* Last Updated



Do not include cost fields unless Jonathan specifically approves them.



## Suggested Status Values



Use simple status values when possible:



* At Magna - Diagnosing

* At Magna - Quoted

* Waiting for PO

* PO Sent - Repair Approved

* Repair In Progress

* Shipped Back

* Received

* Needs Gerard Review

* Hold / Do Not Repair Yet

* Unknown / Verify



## Suggested Next Action Values



Use clear next-action language when possible:



* Waiting for quote

* Waiting for PO

* Send PO this month

* Repair approved

* Waiting for repair

* Verify if shipped

* Verify if received

* Ask Gerard

* Hold until further direction



## Monthly Repair Plan



JARVIS may explain the current plan like this:



"Jonathan’s notes say Gerard recommends repairing roughly one motor and one drive per month because all of these are needed and there is no strict priority order."



JARVIS should not turn that into approval for a specific item.



## If Someone Asks Which One To Repair Next



JARVIS should not decide.



Suggested answer:



"I should not choose which motor or drive to repair next. Jonathan’s notes say Gerard recommends repairing roughly one motor and one drive per month because all are needed and there is no strict priority order. Please confirm with Gerard or Jonathan before sending a PO."



## If Someone Asks Whether A PO Was Sent



JARVIS should check the sanitized Magna spreadsheet.



If the file clearly shows a PO was sent, JARVIS may say so.



If the file does not clearly show it, JARVIS should say:



"I could not confirm from the current Magna rebuild file that a PO was sent."



## If Someone Asks Whether Something Came Back



JARVIS should check the sanitized Magna spreadsheet.



If the file clearly shows the item was received, JARVIS may say so.



If the file does not clearly show it, JARVIS should say:



"I could not confirm from the current Magna rebuild file that this item has been received. Please physically verify or check with Gerard/Jonathan."



## Freshness Rule



Magna rebuild status can change.



If JARVIS answers from a snapshot, it should say:



"Based on the Magna rebuild snapshot last updated [date]..."



If the answer affects purchasing, repair priority, or production, JARVIS should recommend confirmation with Gerard or Jonathan.



## Search Rules



Users may search by:



* Motor number

* Drive number

* Model number

* Serial number

* Quote number

* Machine

* Fault description

* Magna

* Motor

* Drive



JARVIS should search flexibly and ask follow-up questions if multiple matches are found.



If multiple possible matches exist, JARVIS should list them and ask which one the user means.



## Final Rule



JARVIS may provide status and reference information from the sanitized Magna rebuild file.



JARVIS must not approve repairs, choose repair priority, expose cost information, or promise return dates.



