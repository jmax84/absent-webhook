# Data Last Updated



This file tracks when the JARVIS knowledge base was last updated.



JARVIS should use this file to understand whether information may be stale.



## Overall Knowledge Package



Knowledge package name:



`JARVIS_DATA_FINAL_2026-06-XX`



Overall package last updated:



`2026-06-XX`



Prepared by:



`Jonathan Maxwell`



Purpose:



This knowledge package was prepared to help coworkers find information while Jonathan is unavailable.



## General Freshness Rule



Some files are static reference documents. Other files are snapshots that may become outdated.



If JARVIS answers from a snapshot file, it should mention the snapshot date when useful.



Example:



"Based on the parts inventory snapshot last updated 2026-06-XX..."



If the answer depends on real-time status, JARVIS should remind the user to physically verify or check with supervision.



## Category Update Dates



| Category                    | Folder                         | Last Updated | Data Type            | Freshness Risk | Notes                                                      |

| --------------------------- | ------------------------------ | -----------: | -------------------- | -------------- | ---------------------------------------------------------- |

| Start Here / Rules          | 00_START_HERE                  |   2026-06-XX | Rules / index        | Low            | Core JARVIS behavior rules                                 |

| Parts Inventory             | 01_PARTS_INVENTORY             |   2026-06-XX | Snapshot             | High           | Quantity and location may change after export              |

| Open Orders                 | 02_OPEN_ORDERS                 |   2026-06-XX | Snapshot             | High           | Order status may change quickly                            |

| Ink Room                    | 03_INK_ROOM                    |   2026-06-XX | Mixed                | Medium         | Vendor contacts are more stable; inventory/logs may change |

| HVAC and Building           | 04_HVAC_AND_BUILDING           |   2026-06-XX | Notes / reference    | Medium         | AC status can change quickly                               |

| Knives                      | 05_KNIVES                      |   2026-06-XX | Snapshot             | High           | Knife status can change when used or sent out              |

| Purchasing / PO Requests    | 06_PURCHASING_PO_REQUESTS      |   2026-06-XX | Policy / form        | Low            | Process should be stable unless policy changes             |

| Magna Rebuilds              | 07_MAGNA_REBUILDS              |   2026-06-XX | Snapshot             | Medium / High  | Repair status and received status may change               |

| Mailshop Equipment Outgoing | 08_MAILSHOP_EQUIPMENT_OUTGOING |   2026-06-XX | Snapshot             | High           | Pickup/staging status may change                           |

| Maps                        | 09_MAPS                        |   2026-06-XX | Reference            | Medium         | Physical locations may change if equipment moves           |

| Safety Training             | 10_SAFETY_TRAINING             |   2026-06-XX | Snapshot / reference | Medium         | Certification status may change                            |

| 2-2-3 Schedule              | 11_2-2-3_Schedule              |   2026-06-XX | Schedule             | Medium         | Schedule applies to day shift only starting June 14, 2026  |

| Do Not Use Yet              | 99_DO_NOT_USE_YET              |   2026-06-XX | Not approved         | N/A            | JARVIS should not answer from this folder                  |



## High-Risk Snapshot Categories



The following categories can become outdated quickly:



* Parts inventory

* Open orders

* Knife status

* Mailshop equipment outgoing status

* Magna repair status

* Ink inventory

* HVAC active issue status



When answering from these categories, JARVIS should avoid overconfidence.



Use wording like:



"Based on the latest JARVIS snapshot..."



or:



"This may have changed since the snapshot. Please verify before relying on it."



## Low-Risk Reference Categories



The following categories are more stable:



* PO request policy

* Blank PO request form

* General vendor contact notes

* General schedule rules

* JARVIS rules

* JARVIS index



JARVIS can answer these more directly unless there is reason to believe the information changed.



## Physical Verification Rule



For anything involving physical inventory, equipment, tools, knives, or staged items, JARVIS should remind users to verify if the answer affects production.



Example:



"JARVIS shows this item as on hand in the latest snapshot, but please physically verify before assuming it is available."



## No Guessing Rule



If the data does not clearly answer the question, JARVIS should say:



"I could not confirm that from the current JARVIS files."



Then it should suggest the safest next step.



## Final Vacation Update



Before Jonathan leaves, update this file with the final export date for each category.



Final pre-vacation update completed:



`Not yet completed`



