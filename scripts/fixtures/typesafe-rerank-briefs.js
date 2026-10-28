/**
 * Sample briefs for the offline rerank comparison.
 *
 * `before` is the shortlist order candidate search already produced
 * (embedding / graph / keyword). `mockedRaw` is what a System One Score
 * response would put in `answers.*.score` for style, placement, and subject
 * on the 0..3 rubric. Nothing here calls TypeSafe.
 */

export const BRIEFS = [
  {
    id: 'forearm-botanical',
    kind: 'artist',
    brief: { text: 'Fine-line botanical sprig on the inner forearm' },
    before: [
      {
        id: 'kenji',
        label: 'Kenji Sato — traditional dragon, back',
        name: 'Kenji Sato',
        styles: ['Traditional'],
        city: 'Los Angeles',
        placement: 'back',
      },
      {
        id: 'noor',
        label: 'Noor Hale — fine-line botanicals, forearm',
        name: 'Noor Hale',
        styles: ['Fine Line'],
        city: 'Los Angeles',
        placement: 'forearm',
      },
      {
        id: 'alex',
        label: 'Alex Ruiz — blackwork geometry, calf',
        name: 'Alex Ruiz',
        styles: ['Blackwork'],
        city: 'Los Angeles',
        placement: 'calf',
      },
    ],
    mockedRaw: {
      kenji: { style: 0, placement: 0, subject: 0 },
      noor: { style: 3, placement: 3, subject: 3 },
      alex: { style: 1, placement: 1, subject: 0 },
    },
    afterIds: ['noor', 'alex', 'kenji'],
  },
  {
    id: 'japanese-backpiece',
    kind: 'artist',
    brief: { text: 'Japanese dragon across the upper back, bold traditional' },
    before: [
      {
        id: 'noor',
        label: 'Noor Hale — fine-line botanicals, forearm',
        name: 'Noor Hale',
        styles: ['Fine Line'],
        city: 'Los Angeles',
        placement: 'forearm',
      },
      {
        id: 'alex',
        label: 'Alex Ruiz — blackwork geometry, calf',
        name: 'Alex Ruiz',
        styles: ['Blackwork'],
        city: 'Los Angeles',
        placement: 'calf',
      },
      {
        id: 'kenji',
        label: 'Kenji Sato — traditional dragon, back',
        name: 'Kenji Sato',
        styles: ['Traditional'],
        city: 'Los Angeles',
        placement: 'back',
      },
    ],
    mockedRaw: {
      noor: { style: 0, placement: 1, subject: 0 },
      alex: { style: 0, placement: 0, subject: 0 },
      kenji: { style: 3, placement: 3, subject: 3 },
    },
    afterIds: ['kenji', 'noor', 'alex'],
  },
  {
    id: 'raven-thigh',
    kind: 'design',
    brief: { text: 'blackwork raven on the thigh' },
    before: [
      {
        id: 'wrist',
        label: 'Script “nevermore” on the wrist',
        subject: 'raven quote',
        style: 'Script',
        placement: 'wrist',
      },
      {
        id: 'thigh',
        label: 'Blackwork raven on the thigh',
        subject: 'raven',
        style: 'Blackwork',
        placement: 'thigh',
      },
      {
        id: 'forearm',
        label: 'Fine-line raven on the forearm',
        subject: 'raven',
        style: 'Fine Line',
        placement: 'forearm',
      },
    ],
    mockedRaw: {
      wrist: { style: 0, placement: 0, subject: 1 },
      thigh: { style: 3, placement: 3, subject: 3 },
      forearm: { style: 1, placement: 0, subject: 3 },
    },
    afterIds: ['thigh', 'forearm', 'wrist'],
  },
];
