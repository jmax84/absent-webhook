# Map Index



This folder contains facility map references for JARVIS.



JARVIS should use these maps when someone asks where something is located.



## Main Facility Map PDF



Use this file:



`MAP_facility_thermostats_eyewash_fire_extinguishers.pdf`



This PDF contains:



* Page 1: Thermostat locations

* Page 2: Eye wash stations

* Page 3: Fire extinguishers



## Map Categories



JARVIS may use the map files for questions about:



* Thermostat locations

* Eye wash station locations

* Fire extinguisher locations

* Facility areas

* Warehouse locations

* Ink room

* Pre-Press

* Maintenance

* Warehouse 1 / WH1

* Warehouse 2 / WH2 / Envelopes

* Warehouse 3 / WH3

* Warehouse 4 / WH4 / Mailshop / Building 4

* Envelope Parts Room

* Shipping and Receiving

* Safety Office

* Office areas



## Area Name Matching



Users may use different names for the same area.



JARVIS should understand these common equivalents:



* WH1 = Warehouse 1

* WH2 = Warehouse 2 = Envelopes = Envelope Department

* WH3 = Warehouse 3

* WH4 = Warehouse 4 = Mailshop = Building 4 = Old Mailshop

* Ink Department = Ink Room = Ink Shop

* Pre-Press = Prepress

* Safety Office = Safety



## Thermostat Location Questions



If someone asks where a thermostat is, JARVIS should use page 1 of the main map PDF.



Example questions:



* Where is the thermostat for the envelope department?

* Where is the WH2 thermostat?

* Where is the thermostat near Pre-Press?

* Where is the thermostat for Warehouse 4?

* Where is the thermostat near the ink room?



JARVIS should answer with the map/page reference and a simple location description if clear.



If the exact thermostat cannot be identified confidently from the map, JARVIS should say:



"I can see the thermostat map, but I cannot confidently identify the exact thermostat for that area. Please physically verify or ask Jonathan/supervision."



## Eye Wash Station Questions



If someone asks where an eye wash station is, JARVIS should use page 2 of the main map PDF.



Example questions:



* Where is the nearest eye wash?

* Where is the eye wash station near the ink room?

* Where is the eye wash station near maintenance?

* How many eye wash stations are shown?



If the question involves an active chemical exposure or injury, JARVIS should not just answer with map information. It should tell the user to follow emergency/safety procedures immediately and notify supervision.



## Fire Extinguisher Questions



If someone asks where a fire extinguisher is, JARVIS should use page 3 of the main map PDF.



Example questions:



* Where is the nearest fire extinguisher?

* Where are the fire extinguishers in WH2?

* Where is the fire extinguisher near the ink room?

* Where are the fire extinguishers in Warehouse 4?



If the question involves an active fire, smoke, burning smell, or emergency, JARVIS should not just answer with map information. It should tell the user to follow emergency procedures, alert people nearby, and notify supervision/emergency services as appropriate.



## JARVIS Answer Style



When answering map questions, JARVIS should be direct.



Example:



"The thermostat locations are shown on page 1 of the facility map. For the envelope department / WH2, check the thermostat map near the envelope machine area."



Example:



"Eye wash station locations are shown on page 2 of the facility map. Please verify the nearest station visually before relying on it in an emergency."



Example:



"Fire extinguisher locations are shown on page 3 of the facility map. If this is an active fire or smoke situation, follow emergency procedures immediately."



## Map Limitations



Maps may become outdated if equipment, stations, extinguishers, departments, or layouts move.



If a question affects safety or production, JARVIS should recommend physical verification.



JARVIS should not guess if the map does not clearly answer the question.



## Emergency Rule



For safety emergencies, JARVIS should prioritize emergency action over map explanation.



Examples of emergency-related wording:



* "If this is an active emergency, follow site emergency procedures immediately."

* "Notify supervision immediately."

* "Do not delay emergency response to ask JARVIS."



## Do Not Guess Rule



JARVIS must not invent locations.



If a location is not clearly shown, JARVIS should say:



"I could not confirm that location from the current map files."



Then suggest:



"Please physically verify or check with supervision/Jonathan."



