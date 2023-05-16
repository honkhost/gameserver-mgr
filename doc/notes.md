
## overlayfs commands

```
mergerfs \
  -o cache.files=partial,dropcacheonclose=true,category.create=mfs,fsname=example-serverfiles \
  /opt/gsm/persist/example-server/serverfiles=RW:/opt/gsm/config/example-server/serverfiles=RO:/opt/gsm/base/csgo=RO \
  /opt/gsm/merged/example-server/serverfiles
```

```
mount -t overlayfs \
  example-server \
  -o lowerdir=/opt/gsm/config/gsm-ex-casual-server/serverfiles:/opt/gsm/base/csgo \
  -o upperdir=/opt/gsm/persist/gsm-ex-casual-server/serverfiles \
  -o workdir=/opt/gsm/workdir/gsm-ex-casual-server/serverfiles \
  /opt/gsm/merged/gsm-ex-casual-server/serverfiles
```

```
fuse-overlayfs \
  -o lowerdir=/opt/gsm/config/gsm-ex-casual-server/serverfiles:/opt/gsm/base/csgo \
  -o upperdir=/opt/gsm/persist/gsm-ex-casual-server/serverfiles \
  -o workdir=/opt/gsm/workdir/gsm-ex-casual-server/serverfiles \
  /opt/gsm/merged/gsm-ex-casual-server/serverfiles
```

## launch the server

```
LD_LIBRARY_PATH=/opt/gsm/merged/example-server/serverfiles/bin:$LD_LIBRARY_PATH ./srcds_linux \
  -game csgo \
  -usercon \
  -norestart \
  -strictportbind \
  -ip 10.13.58.51 \
  -port 27015 \
  -tickrate 128 \
  -maxplayers_override 8 \
  +map de_nuke
```

## locks:

all modules must check for these and bail out/wait accordingly: \
used for cli and admin modules to block all actions \
`globalInstance-${gameId}-${instanceId}` \
`globalGame-${gameId}`

lifecycleManager sets this lock: \
`lifecycleManager-${gameId}-${instanceId}`

downloadManager must have these to download base files: \
`downloadGame-${gameId}` \
it must also check for `baseMount-${gameId}-.*` and wait if any are present

configManager sets this lock to block overlayManager from mounting config \
`configDownload-${gameId}-${instanceId}` \
it checks `configMount-${gameId}-${instanceId}` and waits for it to clear

then later overlayManager sets these two \
`configMount-${gameId}-${instanceId}` \
`baseMount-${gameId}-${instanceId}`

overlayManager checks and waits on these: \
`configDownload-${gameId}-${instanceId}` \
`baseMount-${gameId}-${instanceId}` \
`running-${gameId}-${instanceId}`

serverProcessManager sets this lock when the gameserver process is running: \
`running-${gameId}-${instanceId}` \
and checks to make sure these are set before starting it: \
`baseMount-${gameId}-${instanceId}` \
`configMount-${gameId}-${instanceId}` \
