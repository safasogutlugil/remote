# TV Remote (browser-only)

A remote for an LG webOS TV that runs entirely in the phone's browser. There's no server: each phone talks straight to the TV over your home Wi-Fi.

What it can't do: turn the TV **on**. Browsers can't send the Wake-on-LAN signal for that, so use the TV's own remote, and this one takes over from there. It can turn the TV off, and it can turn the screen off and back on while sound keeps playing.

## Put it online (once)

The page has to be served over HTTPS, because the TV only accepts secure connections. Any static host works. These are plain files with no build step.

**GitHub Pages:**
1. Create a repository (it can be private on paid plans) and upload everything in this folder.
2. Open the repo's Settings → Pages, set Source to "Deploy from a branch", and pick `main` / root.
3. After a minute it's live at `https://<you>.github.io/<repo>/`.

Netlify Drop, Cloudflare Pages, or a folder on a domain you already run work just as well.

## Set up each phone (once per phone)

Open the link on the phone. The setup screen walks through these steps:

1. Turn the TV on, with the phone on the same Wi-Fi.
2. Enter the TV's IP address (TV: Settings → Network → Wi-Fi connection → Advanced Wi-Fi settings).
3. Tap **Open the TV's certificate page** and accept the browser's warning. The TV uses a self-signed certificate, and this tells the browser to trust it.
4. Tap **Connect** and accept the prompt on the TV.

Then add the page to the home screen. On iPhone: Share → Add to Home Screen. On Android: menu → Add to Home screen.

Everything is stored in that phone's browser: the TV address and its pairing key. To share the remote, send the link; each person does the setup on their own phone.

## Things to know

- **Give the TV a fixed IP** in your router (DHCP reservation). The browser can't search the network, so if the TV's address changes, you'll have to enter it again.
- **Chrome forgets accepted certificates after about a week.** When the remote says it can't reach a TV that's on, tap the status line and redo step 3.
- **iPhone:** if it won't connect from the home-screen icon, try the same link in a Safari tab. Home-screen web apps on iOS can keep certificate trust separately from Safari.
- **Chrome may ask to "access devices on your local network."** Allow it; that's this page talking to the TV.
