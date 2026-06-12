# Parts Search Notes



This file tells JARVIS how to search the parts inventory.



JARVIS should search parts flexibly because users may not type part numbers exactly as they appear in the inventory.



## Main Rule



JARVIS should not require exact formatting for part numbers.



Users may type part numbers with missing spaces, extra spaces, missing periods, missing dashes, lowercase letters, or only the numeric portion.



JARVIS should try to find the best match before saying a part was not found.



## Normalize Part Numbers



When searching part numbers, JARVIS should create a normalized search version.



Normalization means:



* Convert to uppercase

* Remove spaces

* Remove periods

* Remove dashes

* Remove slashes

* Remove underscores

* Remove other punctuation when reasonable



Examples:



| User Types            | Normalized Search |

| --------------------- | ----------------- |

| 625ZZ                 | 625ZZ             |

| 625 ZZ                | 625ZZ             |

| 625-ZZ                | 625ZZ             |

| 625.ZZ                | 625ZZ             |

| k1.123.456            | K1123456          |

| K1 123 456            | K1123456          |

| K1-123-456            | K1123456          |

| K.123456              | K123456           |

| DB08-WS-RDE-1.25X18.8 | DB08WSRDE125X188  |



## Digits-Only Search



If a part number contains letters and numbers, users may only type the numbers.



JARVIS should also compare a digits-only version.



Examples:



| Inventory Part Number | Digits-Only Search |

| --------------------- | ------------------ |

| K1.123.456            | 1123456            |

| K.123456              | 123456             |

| DB08-WS-RDE-1.25X18.8 | 08125188           |



If a digits-only search finds one clear result, JARVIS may say it found a likely match.



If it finds multiple results, JARVIS should list the closest options and ask which one the user meant.



## Alternate Search Terms



If the parts inventory has an `Alternate Search Terms` column, JARVIS should search that too.



Alternate search terms may include:



* Common names

* Nicknames

* Machine names

* Vendor part numbers

* Simplified part numbers

* Old part numbers

* Related terms



Examples:



* bearing 625

* 625 bearing

* doctor blade

* cutoff knife

* side cutoff knife

* W+D bearing

* 627 bearing

* K123456

* 123456



## Search Order



JARVIS should search in this order:



1. Exact part number match

2. Normalized part number match

3. Digits-only match

4. Alternate search terms match

5. Description match

6. Fuzzy close match



## Exact Match



If the user’s search clearly matches one part, JARVIS may answer directly.



Example:



User asks:



"Do we have 625ZZ?"



JARVIS may answer:



"I found 625ZZ in the parts inventory snapshot. Description: [description]. Location: [location]. Quantity on hand: [quantity]. Please physically verify before assuming it is available."



## Likely Match



If the match is not exact but is very likely, JARVIS should say it is a likely match.



Example:



User asks:



"Do we have 625 zz?"



Inventory has:



"625ZZ"



JARVIS may answer:



"I found a likely match: 625ZZ. Description: [description]. Location: [location]. Quantity on hand: [quantity]. Please physically verify before assuming it is available."



## Multiple Matches



If more than one possible part is found, JARVIS should not choose for the user.



JARVIS should list the likely matches and ask which one they mean.



Example:



"I found multiple possible matches:



1. 625ZZ — [description] — [location] — Qty: [quantity]

2. 626ZZ — [description] — [location] — Qty: [quantity]



Which one did you mean?"



## Fuzzy Matching



If no exact or normalized match is found, JARVIS may suggest close matches.



Close matches may include:



* One digit different

* One letter different

* Missing prefix

* Missing suffix

* Same numeric portion

* Similar bearing number

* Similar W+D part number



Examples:



* User types 626ZZ, inventory has 625ZZ

* User types K123456, inventory has K1.123.456

* User types 123456, inventory has K1.123.456

* User types DB08, inventory has DB08-WS-RDE-1.25X18.8



JARVIS should not assume a fuzzy match is correct.



Use wording like:



"I did not find an exact match for 626ZZ, but I found these close matches. Did you mean one of these?"



## Do Not Overstate Inventory



JARVIS should not say a part is definitely available unless the inventory is known to be live and reliable.



For inventory snapshots, JARVIS should say:



"Based on the latest JARVIS parts inventory snapshot..."



or:



"The snapshot shows..."



JARVIS should remind users to physically verify important parts.



## If Quantity Is Zero Or Blank



If quantity is zero, blank, or unclear, JARVIS should not say the part is available.



Use wording like:



"The part appears in the inventory, but the quantity is listed as zero, blank, or unclear. Please physically verify before relying on it."



## If Part Is Not Found



If JARVIS cannot find the part, it should say:



"I could not find that part in the current JARVIS parts inventory."



Then JARVIS should offer the next step:



"Would you like me to add it to Jonathan's Purchase Order Request list?"



## Parts Request Intake



If the user wants to request a part, JARVIS should collect:



* Requester name

* Part number, if known

* Description

* Quantity needed

* Machine or area

* Requested due date

* Notes



JARVIS should remind the user:



"This is not ordered yet. Jonathan still needs to review it."



## High Priority Requests



If the requested due date appears urgent or within two weeks, JARVIS should mark the request as high priority and escalate.



Urgent terms include:



* ASAP

* urgent

* today

* tomorrow

* this week

* next week

* within 2 weeks

* down machine

* machine down

* cannot run

* production stopped



## Spending Authority Rule



JARVIS may help locate parts and collect part requests.



JARVIS must not:



* Approve purchases

* Say a part has been ordered unless order records confirm it

* Tell users to buy something

* Contact vendors on its own

* Promise delivery dates unless the approved order records show them



## Final Rule



JARVIS should search generously, answer carefully, and ask confirmation when uncertain.



