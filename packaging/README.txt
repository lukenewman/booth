booth
=====

Starting booth
--------------
1. Move this booth folder wherever you like (Applications is fine).
2. Double-click "booth.command". A Terminal window opens and booth appears in
   your browser. Keep that window open while you use booth; closing it
   stops booth.

The first time: macOS will refuse to open it
--------------------------------------------
booth isn't from the App Store, so the first double-click shows a warning
that it "cannot be opened" or "could not be verified". Click Done, then:

  System Settings → Privacy & Security → scroll down → "Open Anyway"
  next to the message about booth.command, then confirm.

You only do this once.

Connecting your Discogs account
-------------------------------
On the first run, booth walks you through making a Discogs token and
pasting it in. It checks the token with Discogs and saves it for next time.

The settings file lives at ~/.booth/settings.env. In Finder use
Go → Go to Folder… and type ~/.booth to find it later.

Your data
---------
Everything booth stores (its database, backups, recordings, artwork) lives
in ~/.booth. Replacing this booth folder with a newer version keeps it all.
