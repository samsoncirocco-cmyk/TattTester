---
status: accepted
---

# A lettering Noul abstains when it is unsure

The render text guard decides whether a customer asked for words in the
tattoo. That decision can be a keyword list or, when `TYPESAFE_LETTERING` is
on, one TypeSafe Noul. The flag defaults off.

## The decision

A Noul has no separate confidence. Treat the probability in three bands:

- at or above 0.7, the request asked for lettering
- at or below 0.3, it did not
- between those lines, keep the keyword check

A timeout, HTTP error, parse error, missing key, or denied budget also keeps
the keyword check. The Noul does not replace Gemini OCR. The call is checked
against the shared spend cap and debited one cent after a 2xx. That cent is
the existing text-call over-estimate. It does not change `BUDGET_MAX_SPEND_CENTS`.

No held-out measurement of this Noul is recorded here. Turning the flag on
is not evidence that the model is calibrated.
