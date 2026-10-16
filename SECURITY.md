# Security policy

## Supported versions

I only support the latest release. If you're on an older version, please update before reporting.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/VagueDustin/spindle-streamdeck/security) and choose **Report a vulnerability**. Don't open a public issue for a security problem.

Spindle is a hobby project that I maintain alone, so I answer on a best-effort basis. I'll read every report, but I can't promise a response time.

## What's in scope

- **Token handling:** how the Home Assistant token is stored, sent or logged.
- **Network access:** where Spindle connects, and anything that could send the token somewhere other than your Home Assistant.
- **Decoding untrusted cover art:** the PNG and JPEG decoders handle images from outside sources, so malformed images that crash, hang or exhaust memory are in scope.
- **The property inspector:** the settings page where you enter your URL and token.

## Never post your token or URL

Don't put your Home Assistant token or URL in an issue, a pull request or a log excerpt, public or private. If you think your token has leaked, revoke it in Home Assistant under **Profile → Security** and create a new one.
