# RxOnly

**A secure, read-only web interface for monitoring [Meshtastic](https://meshtastic.org/) nodes and messages.**


RxOnly consists of two main parts. One, a collector script to watch what your Meshtastic node hears and log it to SQLite. The other component is a small [Flask](https://flask.palletsprojects.com) based web application that lets you explore that data in a browser. It exposes a simple web UI that allows viewing active nodes, node details, selected channel traffic, and direct messages received by the local device without ever allowing message transmission or direct access to the Meshtastic CLI.

The application is intended to be lightweight, low-dependency, and security focused. All interaction with the Meshtastic device happens through a controlled backend process, and the web layer is strictly read-only. The goal is observability, not control.

This project is built for personal use and experimentation, prioritizing clarity, safety, and ease of maintenance over features.

> **IMPORTANT**
>
> While I’ve made a conscious effort to keep this project as secure as possible, there is still real risk involved in exposing any service on a home network to the public internet.
>
> If you deploy RxOnly in a way that makes it publicly accessible, you will almost certainly be exposing your home IP address, and you are responsible for understanding and accepting the security implications of doing so. This project is provided as a read-only dashboard, but that does not eliminate the broader risks that come with running publicly reachable services.
>
> If you’re not comfortable thinking through things like network exposure, reverse proxies, SSH hardening, firewall rules, and access control, you should take the time to do so before deploying this publicly.

> **ALSO:** Do not expose private channels or DMs that are assumed to be private to the public internet. That’s not cool, and it is **not** what this project is intended for. Private channels are private for a reason.




## Installation & Getting Started

This project uses [uv](https://docs.astral.sh/uv/) for Python dependency management and virtual environments.

### Prerequisites
- Python 3.10 or newer
- `uv` installed globally
- A Meshtastic-compatible node (for live data collection)

### Clone the repository

```
git clone https://github.com/epohs/RxOnly.git
cd RxOnly
```

### Create the virtual environment


A single virtual environment is used for both the collector and the web app.

```
uv init
# Install dependencies
uv sync
```

### Customize your `rxonly/config.json` file

Copy the [`rxonly/config-sample.json`](/rxonly/config-sample.json) file and create a new `config.json` file. I think the values are fairly self-explanatory with one exception.

The setting `SERIAL_PORT` in the example uses the device name for maximum compatibility, but this could be unreliable. For more reliable connectivity to your Meshtastic device, first ensure that it is connected to the host computer, then run: `ls -l /dev/serial/by-id/`

You should see something like: `usb-RAKwireless_WisCore_RAK4631_Board_1X2X3X4X5X6X-if00 -> ../../ttyACM0`

Use that value in your own `config.json` using `“SERIAL_PORT”: “/dev/serial/by-id/YOUR_DEVICE_ID”,` instead of the `/dev/DEVICE_NAME` that I have in my example.

Setting `DEBUG` to true will disable compression of the site by [Flask-Compress](https://pypi.org/project/Flask-Compress/), and will serve the unminified CSS and JS files, as well as writing more verbose logs.


### Running the Collector

The collector connects to the Meshtastic node and stores received packets in SQLite.

```
source .venv/bin/activate
python scripts/run_collector.py
```

The database will be created and migrated automatically if needed. Nodes and messages will be written to the database as long as this script is running.

> **NOTE:** If you pull the repo and the database schema ([`schema.sql`](/rxonly/db/schema.sql)) version changes your database will be dropped and recreated, wiping all existing data.

### Running the Web App (Flask)

The Flask application exposes a private JSON API and serves a small frontend.

```
source .venv/bin/activate
flask --app rxonly.web run
```

The app will be available at:

```http://127.0.0.1:5000```





## One Real Use Case

I use this project to see what’s going on with the Meshtastic network back home while I am traveling. Also, I find it a little quicker to visit a webpage than to open the Meshtastic app, so I even use it at home.

Specific deployment and infrastructure guides are beyond the scope of this project. RxOnly focuses on providing the collector script and the read-only web dashboard. That said, there are a handful of example configuration files and scripts in the [`deploy`](/deploy) directory that may be useful as reference when setting up your own environment.

On my local network, this project runs on a [Raspberry Pi](https://www.raspberrypi.com/). My Meshtastic device is connected directly to the Pi via a USB-C cable. The Pi is responsible for both collecting data from the node and for serving the web dashboard.

To get started, I cloned this repository into a subdirectory of my home directory on my Pi and got the Flask application running as described in the **Install** section above. From there, I created two `systemd` services: one to keep the collector process running continuously in the background, and another to run the Flask application using [gunicorn](https://gunicorn.org/).

In front of the Flask app, I use [nginx](https://nginx.org/) as a reverse proxy. Nginx handles incoming HTTP(S) requests, terminates TLS, and forwards traffic to the Flask application running on localhost. SSL certificates are managed and automatically renewed using [Let’s Encrypt](https://letsencrypt.org/).

Because this is running on a home network where the public IP address can change, I also run a small script periodically via `cron` that uses the [Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/update/) to update a subdomain on a domain that I own. This ensures the subdomain always points to the Raspberry Pi, even if my ISP changes my IP address.


## A Hypothetical Use Case

This project could be set up and made public with the intention of creating a mesh-based community bulletin board.

Imagine a handful of custom channels created around specific discussion topics (think old-school web forums). The dashboard becomes a simple, read-only window into those conversations, visible to anyone on the web. If someone wants to participate, there’s no account to create and no app to install — all they need is a working Meshtastic node and to be within range.

It’s a low-friction way to surface local mesh-native conversations to a wider audience, while keeping participation grounded in the mesh itself.



## API Endpoints

- `GET /api/stats` - Dashboard statistics and local node info
- `GET /api/nodes` - List all nodes (supports `?limit`, `?offset`, `?search`)
- `GET /api/nodes/<node_id>` - Single node details
- `GET /api/channels` - List tracked channels
- `GET /api/messages` - Channel messages (supports `?channel_index`, `?limit`, `?after_rx_time`, `?before_rx_time`, `?newest`)
- `GET /api/messages/<message_id>` - Single message details
- `GET /api/direct-messages` - Direct messages received by local node
- `GET /api/direct-messages/<message_id>` - Single DM details



## Helpful commands

- `journalctl -u rxonly-collector -f` View the logs output by the collector process (Assuming you have it running as a `systemd` daemon).

- `journalctl -u rxonly-www -f` View the logs output by the Flask/Gunicorn process.

- `sudo systemctl restart rxonly-collector` Restart the collector script.

- `sudo systemctl restart rxonly-www` Restart the Flask application.


## To-Do

1. Add mapping (Probably later).


Licensed under the GNU AGPL-3.0
Copyright (c) 2026 epohs
