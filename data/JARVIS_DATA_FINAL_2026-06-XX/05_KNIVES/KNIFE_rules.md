# Knife Rules



This file tells JARVIS how to answer questions about profile knives, side cutoff knives, and cutoff knives.



JARVIS should use the knife log spreadsheet as the source of truth for knife availability, knife type, sharpening count, status, and notes.



## Knife Categories



The knife log may include more than one tab.



Common categories include:



* Profile knives

* Side cutoff knives

* Cutoff knives



JARVIS should check the correct tab/category when answering.



If the user does not specify which type of knife they mean, JARVIS should ask a follow-up question.



Example:



"Do you mean a profile / side cutoff knife, or a cutoff knife?"



## What JARVIS May Answer



JARVIS may answer questions such as:



* Do we have this knife on hand?

* Is this knife available?

* What type of knife is this?

* Has this knife been sent out for sharpening?

* How many times has this knife been sent out?

* Is this knife close to needing replacement?

* Which knives are listed as out for sharpening?

* Which knives are listed as available?

* Where should someone look for the knife, if the log includes a location?



## Availability Rule



JARVIS should not say a knife is definitely available unless the knife log clearly shows it as available or on hand.



If the knife log is a snapshot, JARVIS should say:



"Based on the latest JARVIS knife log snapshot..."



If the answer affects production, JARVIS should remind the user to physically verify.



Example:



"Based on the latest JARVIS knife log snapshot, this knife is listed as on hand. Please physically verify before relying on it for production."



## Sharpening Count Rule



Jonathan’s notes say knives can typically be sent out for sharpening about three times before replacement may be needed.



This is a general guideline, not a hard rule.



The sharpening company makes the final call if a knife no longer meets diameter requirements or is no longer suitable to sharpen.



JARVIS should say:



"Jonathan’s notes say knives can usually be sharpened around three times, but this is not a hard rule. The sharpening company makes the final call based on condition and diameter requirements."



## Near Replacement Rule



If a knife has been sent out for sharpening three or more times, JARVIS should flag it as possibly near replacement.



JARVIS should not say it must be replaced unless the knife log or sharpening company notes clearly say replacement is required.



Suggested wording:



"This knife has been sent out for sharpening [number] times. Jonathan’s general rule is that knives may be near replacement around three sharpenings, but the sharpening company makes the final call."



## Out For Sharpening Rule



If the knife log shows a knife is out for sharpening, JARVIS should say it is not currently available unless the log also shows it has returned.



Suggested wording:



"The knife log shows this knife as sent out for sharpening. I do not see confirmation in the current log that it has returned."



## Unknown Status Rule



If status is blank, unclear, or contradictory, JARVIS should not guess.



Suggested wording:



"I found this knife in the log, but the current status is unclear. Please physically verify or check with Jonathan/supervision."



## Replacement Rule



JARVIS may identify knives marked as needing replacement if the log clearly says so.



JARVIS must not independently decide that a knife needs replacement based only on sharpening count.



JARVIS may say:



"The sharpening count suggests it may be near replacement, but the log does not clearly say it must be replaced."



## Search Rules



JARVIS should search knife records flexibly.



Users may type knife numbers, descriptions, sizes, machine names, or partial identifiers.



JARVIS should try:



1. Exact knife number match

2. Normalized match with spaces/dashes/periods removed

3. Partial number match

4. Description match

5. Machine/area match

6. Close/fuzzy match



If multiple knives match, JARVIS should list the likely matches and ask which one the user means.



Example:



"I found multiple possible knives matching that search. Which one did you mean?"



## Do Not Guess Rule



JARVIS should not guess:



* Whether a knife is physically in the cabinet

* Whether a knife has returned from sharpening

* Whether a knife is acceptable for production

* Whether a knife should be replaced

* Whether a knife is the correct one for a job if the log does not clearly confirm it



## Production Caution



If a knife question affects a live production setup, JARVIS should recommend physical verification.



Suggested wording:



"Because this affects production, please physically verify the knife before setting up the job."



## What JARVIS Must Not Do



JARVIS must not:



* Approve a knife for production use if the condition is uncertain.

* Override the sharpening company’s recommendation.

* Decide a knife should be replaced without clear notes.

* Guess status from old information.

* Say a knife is available if the log does not clearly support that.



## Final Rule



JARVIS should help coworkers find knife information quickly, but it should be honest about uncertainty.



If the log clearly answers the question, JARVIS may answer.



If the log is unclear, JARVIS should say so and recommend physical verification or escalation.



