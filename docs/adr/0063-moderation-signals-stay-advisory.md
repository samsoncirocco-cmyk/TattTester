---
status: accepted
---

# Moderation signals stay advisory

`TYPESAFE_MODERATION` defaults off. When it is on, one System One call can
flag a design prompt or a takedown/appeal text.

## The decision

The model does not reject a design, take a design down, reinstate an artist,
or decide a trademark or likeness question. A design prompt still generates.
A takedown or appeal is still recorded as pending and is not resolved from
the model.

A person can be told a design was saved for review only after the review
record is written to durable storage and the record carries a correlation id
for the session or request. If that write does not succeed, the product says
it was not saved for review.

No held-out measurement of this screen is recorded here.
