# Presentation notes

Rough bullets, meant to be reworded into your own voice.

## a. Mechanism and question

- Continuous play. The question: "What creates the next action?"
- In chat, nothing has to. Computation is compressed toward zero, so the next prompt follows before any decision to continue is made
- This inverts it: the computation phase is inflated to six minutes and made physical. The next action has to be created on purpose, with a match
- A preventive component, exaggerated through friction. The wait is the interface

## b. Submit to output, in order

- Types a prompt, submits. The message appears; no reply does
- "This computation requires a flame." Terms are stated before anything is committed: six minutes, no pause, cancel, or skip. Then privacy and safety
- Allows the camera. Small mirrored preview, framing guide: "Light a match."
- Strikes a real match. Glow detector plus ml5 classifier confirm about a second of sustained flame
- Camera off, preview folds away, input locks. The on-screen match is the only thing moving
- Char advances continuously; 100% falls to 0% in lockstep with mm:ss. Wall-clock time, so reloading or closing the lid changes nothing
- At zero: the match curls, the flame dies, a wisp of smoke. "Your results await you now." and "view output"
- The next prompt costs another match

## c. Agency, before and after

- Loses: speed, interruptibility (no pause, cancel, skip, even across a reload), and leaving at no cost (a match is spent)
- Gains: an embodied, deliberate commitment (hand, strike, heat, smell), exact knowledge of the wait before agreeing to it, and a stopping point after every single action
- The loop still exists, but each turn has to be chosen. The system no longer creates the next action; the user does

## d. Why this platform

- The web is where the pattern lives; a chat box in a browser is its native habitat
- Browser camera plus on-device ML: the flame is verified without video leaving the machine, so the privacy line is true and checkable
- A URL, no install: everyone in the room can open it and feel the wait themselves
- Vercel: static files, HTTPS by default (the camera requires it), deploys on push
- Native app: exposure lock for steadier detection, a notification at zero, a harder lock. Costs the link, adds an install
- Physical installation: a real flame sensor, no computer vision, a shared ritual. Loses reach, needs supervision and a fire plan

## e. Strongest objection

- "No cancel, no skip, locked input: you removed the user's stopping points. That is the casino's move, not its opposite."
- Response: the lock is on the machine's next action, not on the person. They can walk away; what they cannot do is get another output without choosing it again. Cost and duration are disclosed up front, which a slot machine hides. Every action ends itself
- Also likely: "a real match is out in under a minute, not six" (the strike is the commitment; the screen match is the cost) and "fire is its own spectacle" (one slow, unrewarding, ending spectacle in place of a fast, variable, endless one)
