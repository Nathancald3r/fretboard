# Autopilot tasks

One task per line, worked top to bottom. `[ ]` open, `[x]` done, `[?]` waiting on your answer
(questions.md), `[!]` stuck. Add `| check: <command>` to have the autopilot run its own check too.

- [ ] Finish the strum timing drill (Practice phase 1): js/strumcore.js, js/strum-tap.js, js/strumtime.js and the #strum markup in index.html exist but aren't wired up. Add 'strum' to VIEWS and PRACTICE_VIEWS in js/app.js, call initStrum() in main() and stopStrum() when leaving the view, add a Strum timing card to DRILLS in js/practicehub.js, styles for .st-slots/.st-lane/.st-result in styles.css, and show the .practice-top link only in the player on phones. Check it in the preview. | check: node tests/strumcore.test.mjs
- [ ] Clean-speed loop (Practice phase 1): in js/player.js, when note check (judge.js) is on, the speed trainer goes up only after 3 clean loops in a row (loop score at least 90%) and drops 5% after a messy loop (under 70%). Export the last loop's score from judge.js. Save the best clean tempo per loop range with the song and show it in the speed sheet. Put the rule in a small pure function with a test in tests/.
