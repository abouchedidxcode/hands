/** What each gesture does in the sandbox (drives the legend; the wiring lives in main.ts). */
export const ACTIONS = [
  { id: 'grab', emoji: '✊', gesture: 'Fist', effect: 'Grab the nearest toy and carry it. Open your hand to drop it' },
  { id: 'throw', emoji: '🤾', gesture: 'Fling open', effect: 'Throw what you carry: open the fist while moving fast' },
  { id: 'ball', emoji: '🤏', gesture: 'Pinch tap', effect: 'Drop a bouncy ball' },
  { id: 'crate', emoji: '🫰', gesture: 'Double pinch tap', effect: 'Drop a crate' },
  { id: 'tower', emoji: '✌️', gesture: 'Peace sign', effect: 'Build a block tower' },
  { id: 'lightning', emoji: '🖕', gesture: 'Middle finger', effect: 'Lightning strikes under your fingertip' },
  { id: 'cannon', emoji: '👉', gesture: 'Finger gun', effect: 'Fire a cannonball where you point' },
  { id: 'shockwave', emoji: '🫷', gesture: 'Push', effect: 'Push your palm at the camera: shockwave' },
  { id: 'vacuum', emoji: '🫳', gesture: 'Pull', effect: 'Pull your hand back: suck toys in' },
  { id: 'tornado', emoji: '🌪️', gesture: 'Draw a circle', effect: 'Summon a tornado' },
  { id: 'wind', emoji: '💨', gesture: 'Swipe left / right', effect: 'Gust of wind' },
  { id: 'thunderclap', emoji: '👏', gesture: 'Clap', effect: 'Thunderclap: everything jumps' },
  { id: 'meteors', emoji: '🤘', gesture: 'Rock on', effect: 'Meteor shower' },
  { id: 'fireworks', emoji: '👍', gesture: 'Thumbs up', effect: 'Fireworks' },
  { id: 'clear', emoji: '👎', gesture: 'Thumbs down (hold)', effect: 'Clear the field (again to restore the toys)' },
  { id: 'camera', emoji: '🤲', gesture: 'Two-hand pinch / wheel', effect: 'Spread or squeeze to zoom, turn a wheel to orbit' },
] as const;

export type ActionId = (typeof ACTIONS)[number]['id'];
