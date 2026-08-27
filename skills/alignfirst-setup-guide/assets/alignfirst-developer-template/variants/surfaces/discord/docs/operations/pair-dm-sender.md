---
title: Pair a Discord DM Sender
read_when:
  - a user reports that the developer answered their DM with a pairing code
  - letting a new person reach the developer by direct message
---

# Pair a Discord DM Sender

**Role: operator.**

The seed sets `channels.discord.dmPolicy` to `pairing` and pre-trusts `DISCORD_OWNER_ID` only. Another sender's first DM gets a pairing code (`ABCD-1234`) instead of an answer, and the developer stays silent to them until the code is approved:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw pairing list discord
sudo -i -u {{SERVICE_USER}} -- openclaw pairing approve discord <code>
```

The approval takes effect on the live gateway. The user sends their message again.
