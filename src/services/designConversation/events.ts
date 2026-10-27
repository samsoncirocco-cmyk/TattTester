/**
 * Guess-first intake log events (spec 17). A module of its own so callers
 * that mock the conversation engine still get the real event names.
 */

/** The turn after a guess-first proposal: the customer replied instead of tapping. */
export const GUESS_FIRST_EDITED_EVENT = 'design_conversation.guess_first_edited';

/** At confirm: the confirmed proposal was the bot's guess, taken as said. */
export const GUESS_FIRST_ACCEPTED_EVENT = 'design_conversation.guess_first_accepted';
