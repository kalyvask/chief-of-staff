# Reservations: <Trip name>

Last updated: <YYYY-MM-DD>

Every booked reservation in chronological order. Source of truth for the trip. Flights, hotels, ground transport, meals, meetings with location dependencies, anything time-and-place-bound.

Per reservation: type, confirmation number, start, end, location, cost (if I care to track), provider, status, notes.

---

## <YYYY-MM-DD HH:MM> <Type>

**Confirmation:** <code>
**Provider:** <airline | hotel | rail | car | restaurant | venue>
**From:** <where I depart from, if applicable>
**To:** <where I arrive, if applicable>
**End:** <YYYY-MM-DD HH:MM if relevant (checkout, return flight)>
**Status:** <booked | confirmed | needs confirmation | changed | cancelled>
**Cost:** <amount, currency>
**Notes:** <one line: seat, room number, dietary, contact person, anything that matters at the moment>

---

## <YYYY-MM-DD HH:MM> <Type>

**Confirmation:** <code>
**Provider:** <name>
**Status:** <booked | confirmed | needs confirmation>
**Notes:** <one line>
