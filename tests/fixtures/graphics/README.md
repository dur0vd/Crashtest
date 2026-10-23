# Local synthetic video fixture

Generated from FFmpeg's `testsrc2` (no third-party footage):

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x120:rate=25:duration=0.32' \
  -vf "select='eq(n,0)+eq(n,1)+eq(n,3)+eq(n,4)+eq(n,7)'" \
  -fps_mode vfr -c:v libvpx-vp9 vfr.webm
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time -of csv=p=0 vfr.webm
```

Independent expected presentation timestamps: 0, .04, .12, .16, .28 seconds.
This is a software parsing/decoding fixture, not empirical accident validation.
