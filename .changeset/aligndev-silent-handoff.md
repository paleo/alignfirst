---
"aligndev": patch
---

On OpenClaw, the starter is the channel turn's reply: the turn ends on `NO_REPLY` instead of a pointer to the thread, which Discord posted inside the thread. On Discord, `thread-create` opens the thread without content and `thread-reply` posts the starter.
