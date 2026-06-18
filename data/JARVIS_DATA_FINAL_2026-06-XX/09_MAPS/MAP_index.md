# Map Index

This folder contains facility map references for JARVIS.

JARVIS should use these maps when someone asks where something is located.

JARVIS should show the correct map image when possible. Do not dump this index file as the answer unless the user specifically asks what maps are available.

---

## Available Map Files

### Thermostat Locations

Use this file:

`HVAC_thermostat_locations.png`

This map shows thermostat locations throughout the facility.

JARVIS should show this map when someone asks:

* where is the thermostat?
* where are the thermostats?
* thermostat map
* HVAC controls
* temperature controls
* AC controls
* heat controls

Expected JARVIS answer:

Here is the thermostat location map:

`[image:/kb/04_HVAC_AND_BUILDING/HVAC_thermostat_locations.png]`

---

### Eye Wash Stations

Use this file:

`FACILITY_eye_wash_stations.png`

This map shows eye wash station locations throughout the facility.

JARVIS should show this map when someone asks:

* where is the eyewash?
* where is the eye wash station?
* eye wash map
* eyewash station location
* chemical splash station
* emergency eye wash

Expected JARVIS answer:

Here is the eye wash station map:

`[image:/kb/04_HVAC_AND_BUILDING/FACILITY_eye_wash_stations.png]`

---

### Fire Extinguishers

Use this file:

`FACILITY_fire_extinguishers.png`

This map shows fire extinguisher locations throughout the facility.

JARVIS should show this map when someone asks:

* where is the fire extinguisher?
* where are the fire extinguishers?
* extinguisher map
* fire safety map
* fire extinguisher location

Expected JARVIS answer:

Here is the fire extinguisher map:

`[image:/kb/04_HVAC_AND_BUILDING/FACILITY_fire_extinguishers.png]`

---

### Parts Room Map

Use this file:

`MAP_parts_room_location.png`

This map shows where the Envelope Parts Room / Parts Room is located in relation to the building.

JARVIS should show this map when someone asks:

* where is the parts room?
* show me a map
* show me the parts room map
* where is location 8-B?
* where is bin 8-B?
* where are AA batteries?
* where are AAA batteries?
* where are supplies?
* how do I get to the parts room?
* where is the envelope parts room?
* where is the maintenance parts room?
* where is the parts inventory?

Expected JARVIS answer after a parts/supplies lookup:

AA batteries are listed at Location 8-B.

Here is the parts room map:

`[image:/kb/09_MAPS/MAP_parts_room_location.png]`

Please physically verify before relying on it.

---

## Facility Areas Covered by Maps

JARVIS may use the map files for questions about:

* Thermostat locations
* Eye wash station locations
* Fire extinguisher locations
* Parts room location
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

---

## Map Answer Rules for JARVIS

When someone asks for a map, JARVIS should first determine what kind of map they need.

If the previous answer gave a parts/supplies location, and the user then asks “show me a map,” JARVIS should show the parts room map.

If the user asks for a thermostat map, show the thermostat map.

If the user asks for an eye wash or eyewash station map, show the eye wash station map.

If the user asks for a fire extinguisher map, show the fire extinguisher map.

If JARVIS is not sure which map the user wants, ask a clarifying question:

Which map do you need?

* Parts Room
* Thermostats
* Eye Wash Stations
* Fire Extinguishers

JARVIS should not dump the raw map index unless the user specifically asks what maps are available.

---

## Image Paths for JARVIS

Use these image paths in JARVIS answers:

Parts Room:

`[image:/kb/09_MAPS/MAP_parts_room_location.png]`

Thermostats:

`[image:/kb/04_HVAC_AND_BUILDING/HVAC_thermostat_locations.png]`

Eye Wash Stations:

`[image:/kb/04_HVAC_AND_BUILDING/FACILITY_eye_wash_stations.png]`

Fire Extinguishers:

`[image:/kb/04_HVAC_AND_BUILDING/FACILITY_fire_extinguishers.png]`
