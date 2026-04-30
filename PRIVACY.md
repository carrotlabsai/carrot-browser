# Carrot Browser Privacy Policy

Effective date: April 30, 2026

Carrot Browser ("Carrot") is an open-source Chrome extension and bridge server
that lets a user pair an AI agent with their own browser. The source code for
the extension and bridge server is available at:

https://github.com/carrotlabsai/carrot-browser

The hosted bridge is available at:

https://browser.carrotlabs.ai

This policy explains how Carrot handles user data when you use the Chrome
extension, the hosted bridge, the MCP endpoint, or a self-hosted bridge.

## Summary

Carrot is designed to be a user-controlled pipe between your browser and an
agent that you authorize.

- Carrot does not sell user data.
- Carrot does not use user data for advertising.
- Carrot does not train models on user data.
- The hosted bridge does not persist browsing payloads, screenshots, page
  content, browser history results, bookmarks, console output, or network
  results as product data.
- Browser access requires a user-generated pairing code and is scoped by the
  user to a tab, a window, or the browser.
- The bridge server is open source and can be self-hosted.

## How Carrot Works

Carrot has three parts:

1. The Chrome extension running in your browser.
2. A bridge server, either the hosted bridge at `browser.carrotlabs.ai` or a
   server you run yourself.
3. An AI agent or MCP client that you choose to pair with your browser.

The extension connects to the bridge. When you generate a pairing code and give
it to an agent, the agent can claim a temporary session token. The bridge then
routes structured commands from that agent to your browser and routes command
results back to that agent.

Examples of commands include reading page structure, clicking an element,
typing into a field, taking a screenshot, navigating tabs, reading console
messages, reading network request metadata, or searching browser history or
bookmarks if the session scope allows it.

## User Data Carrot May Handle

Depending on the permissions you grant, the scope you choose, and the commands
requested by your paired agent, Carrot may handle:

- Website content, such as page text, links, page structure, images visible in
  screenshots, and other content from pages you authorize.
- Browser interaction data, such as clicks, typing, scrolling, navigation,
  selected tabs, windows, and tab groups.
- Screenshots captured from authorized tabs or windows.
- Browser history results, including visited page URLs, titles, and associated
  timestamps, when a paired agent requests history access within an authorized
  browser-level session.
- Bookmark data, when a paired agent requests bookmark access within an
  authorized browser-level session.
- Console messages and network request metadata from authorized pages, when
  requested by a paired agent.
- Pairing and session metadata, such as pairing codes, temporary session IDs,
  agent names, browser IDs, selected scopes, creation times, and expiration
  times.
- Basic operational metadata that may be handled by the hosted service or its
  infrastructure, such as IP address, request time, connection status, and
  error information.

Carrot does not intentionally collect health information, financial and payment
information, authentication information, personal communications, or personally
identifiable information as separate product categories. Because Carrot can be
authorized to operate on arbitrary websites, those kinds of information may
appear inside website content if you choose to use Carrot on a site that
contains them.

## How Carrot Uses User Data

Carrot uses user data only to provide user-requested browser automation:

- To route commands from your authorized agent to your browser.
- To return command results from your browser to your authorized agent.
- To show connection, pairing, session, and activity information in the
  extension UI.
- To enforce session scope, expiration, and revocation.
- To operate, secure, debug, and maintain the hosted bridge.

Carrot does not use user data to build advertising profiles, sell data, or
train AI models.

## Hosted Bridge Data Handling

When you use the default hosted bridge at `https://browser.carrotlabs.ai`, data
needed for a command may transit through the hosted bridge between your browser
and your paired agent.

The hosted bridge is designed as a blind routing service. It keeps only the
in-memory state needed to connect your browser to authorized agents, including
browser connection records, pairing codes, temporary sessions, and commands
currently in flight. This state expires or is removed when sessions expire,
pairing codes expire, commands complete, connections close, or you revoke
access.

The hosted bridge does not persist browsing payloads, screenshots, page
content, history results, bookmark results, console output, or network results
as product data.

Like most hosted services, infrastructure used to run the bridge may process
operational metadata such as IP addresses, timestamps, request paths, error
logs, or connection metadata for security, reliability, abuse prevention, and
debugging.

## Extension Local Storage

The Chrome extension stores some settings locally in your browser, including:

- The bridge server URL.
- A generated browser ID.
- A generated browser token.
- Connection mode preferences.

These values are used to connect your browser to the configured bridge server.

## Sharing of User Data

Carrot may share or transmit user data only as needed to provide the service:

- With the AI agent or MCP client that you explicitly authorize using a pairing
  code.
- Through the hosted bridge operated by Carrot Labs when you use the default
  hosted bridge.
- With infrastructure providers that operate, secure, or maintain the hosted
  bridge.
- With a third-party or self-hosted bridge server if you configure the
  extension to use one.

Carrot is not responsible for how a third-party or self-hosted bridge server,
AI agent, MCP client, or other software chosen by you handles data after you
configure or authorize it.

## User Control

You control agent access to your browser:

- Agents cannot access your browser without a pairing code.
- Pairing codes are short-lived.
- Sessions are temporary.
- Sessions can be scoped to a tab, a window, or the browser.
- Active sessions are visible in the Carrot side panel.
- You can revoke sessions from the Carrot side panel.
- You can configure the extension to use your own bridge server instead of the
  hosted bridge.
- You can uninstall the extension at any time.

## Self-Hosting

Carrot is open source. You may run your own bridge server and configure the
extension to use it instead of `https://browser.carrotlabs.ai`.

If you use a self-hosted or third-party bridge, that server's operator controls
how data is handled by that server. This policy applies to the Carrot extension
and the hosted bridge operated for Carrot Browser, not to independently operated
third-party bridge deployments.

## Security

Carrot uses pairing codes, temporary session tokens, browser identity tokens,
scope checks, and visible browser UI to help ensure that browser access is
authorized and understandable.

No system can guarantee perfect security. You should only pair agents and
bridge servers that you trust, and you should avoid granting browser-level
access when tab- or window-level access is sufficient.

## Changes to This Policy

This policy may be updated as Carrot changes. The canonical open-source version
is maintained in the Carrot Browser repository:

https://github.com/carrotlabsai/carrot-browser/blob/main/PRIVACY.md

## Contact

For questions or proposed changes, open an issue or pull request in the Carrot
Browser repository:

https://github.com/carrotlabsai/carrot-browser
