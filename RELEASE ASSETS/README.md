# Windows release assets

This directory is local staging for the newest Mythra Code Windows release only.

`Windows/build.ps1` deletes the previous generated assets before starting a new
release build, preserves this README, and writes the validated installer,
updater signature, `build-info.json`, and `latest.json` here. Generated contents
are ignored by Git and must not be committed.
