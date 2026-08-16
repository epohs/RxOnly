/* ============================================
   RxOnly - Core Application Module
   ============================================
   Configuration, global state, DOM references,
   utility functions, template engine, field maps,
   scroll preservation, read tracking, API layer,
   and breadcrumb navigation.
   ============================================ */

(function() {
  "use strict";

  var RxOnly = window.RxOnly = {};


  /* ------------------------------------------
     Configuration
     ------------------------------------------ */

  var config = {
    fast_poll_interval: 10000,    // 10 seconds
    slow_poll_interval: 20000,    // 20 seconds
    scroll_debounce_delay: 2000,  // 2 seconds after scroll stops
    max_poll_failures: 3,         // Show error after this many failures
    search_debounce_delay: 300,   // 300ms debounce for search
    read_threshold_ratio: 0.33,   // fraction of visible container height from bottom
  };


  /* ------------------------------------------
     State
     ------------------------------------------ */

  var app_state = {
    // "home", "channel", "node", "direct_messages", "conversation", "message".
    // "direct_messages" is the index of conversations — one row per peer — and
    // "conversation" is one thread. The flat all-DMs-at-once list that
    // "direct_messages" used to name is gone, the same replacement mesh-console
    // made: a thread has a peer and a read position of its own, the index has
    // neither.
    current_view: "home",
    current_channel_index: null,
    current_channel_name: null,
    current_channel_url: null,
    // Which thread is on screen when current_view is "conversation" — the peer's
    // node id. Cleared by the views that mean "no thread" and deliberately left
    // alone by the detail views, exactly as current_channel_index is, so a
    // breadcrumb can find its way back.
    current_peer: null,
    current_node_url: null,
    breadcrumbs: [{ label: "Dashboard", href: "/", view: "home" }],
    is_loading_more_nodes: false,

    // Previous view context (for breadcrumb navigation)
    previous_view: null,
    previous_channel_index: null,
    previous_channel_name: null,
    previous_channel_url: null,
    previous_peer: null,

    // Polling state
    fast_poll_timer: null,
    slow_poll_timer: null,
    poll_failure_count: 0,
    // The most recent /api/stats payload, kept so the unread marks can be recomputed
    // when a read position moves without waiting for the next poll.
    last_stats: null,
    known_local_node_id: null,
    known_first_seen: null,

    // Scroll debounce state
    nodes_scroll_timeout: null,
    nodes_scroll_paused: false,
    messages_scroll_timeout: null,
    messages_scroll_paused: false,

    // Cursor-based message pagination state
    messages_has_more_older: false,
    messages_has_more_newer: false,
    messages_is_loading: false,
    messages_oldest_rx_time: null,
    messages_newest_rx_time: null,
    messages_oldest_id: null,
    messages_newest_id: null,
    // No messages_is_dm here on purpose — which conversation is on screen is derived
    // from current_view by current_conversation(), so the two cannot drift apart.
    messages_total: 0,

    // Nodes search state
    nodes_search_query: "",
    nodes_search_debounce_timeout: null,
    nodes_search_request_id: 0,
    total_nodes: 0,
    cached_local_node_name: null,

    // Scroll position preservation
    saved_messages_scroll_top: null,
    saved_messages_is_mobile: false,
    saved_messages_channel_index: null,
    saved_messages_is_dm: false,
    saved_messages_peer: null,

    // Hash routing state
    navigating_from_content: false,

    // Breadcrumb reveal state (mobile scroll-up detection)
    breadcrumb_last_scroll_y: 0,
    breadcrumb_scroll_up_distance: 0,
    breadcrumb_scroll_down_distance: 0,
    breadcrumb_is_sticky: false,
  };


  /* ------------------------------------------
     DOM References
     ------------------------------------------ */

  var dom_elements = {
    body: document.body,
    app_layout: document.querySelector(".app-layout"),
    breadcrumbs_list: document.querySelector(".breadcrumbs ol"),
    main_content: document.getElementById("main-content"),
    nodes_list: document.querySelector(".nodes-list"),
    nodes_count: document.querySelector(".node-count"),
    channels_list: document.querySelector(".channels-list"),
    nodes_list_heading: document.getElementById("nodes-heading"),
    nodes_search_input: document.getElementById("nodes-search-input"),
    nodes_search_clear: document.getElementById("nodes-search-clear"),
  };


  /* ------------------------------------------
     Utility Functions
     ------------------------------------------ */

  function get_node_name_from_data(local_node) {
    if (!local_node) {
      return "";
    }
    if (local_node.long_name) {
      return local_node.long_name;
    }
    if (local_node.short_name) {
      return local_node.short_name;
    }
    if (local_node.node_id) {
      return local_node.node_id;
    }
    return "";
  }

  function update_page_title(stats_data) {
    if (!stats_data || !stats_data.local_node) {
      document.title = "RxOnly";
      return;
    }

    var node_name = get_node_name_from_data(stats_data.local_node);
    var total_nodes = stats_data.stats ? stats_data.stats.total_nodes : 0;

    // Cache the node name for use by update_all_node_counts
    app_state.cached_local_node_name = node_name;

    if (node_name) {
      document.title = node_name + " (" + total_nodes + ")";
    } else {
      document.title = "RxOnly";
    }
  }

  /**
   * Update node count in all display locations:
   * - Page title (if local node name is cached)
   * - Sidebar nodes heading (if no search filter active)
   * - Dashboard stats card (if visible)
   * - Nodes list data attribute
   *
   * Call this whenever a fresh total_nodes count is received from any API.
   */
  function update_all_node_counts(total_nodes) {
    // Update app_state
    app_state.total_nodes = total_nodes;

    // Update page title (only if we have a cached node name)
    if (app_state.cached_local_node_name) {
      document.title = app_state.cached_local_node_name + " (" + total_nodes + ")";
    }

    // Update sidebar nodes heading (only if no search filter)
    if (dom_elements.nodes_count && app_state.nodes_search_query.trim() === "") {
      dom_elements.nodes_count.textContent = "(" + total_nodes + ")";
    }

    // Update nodes list data attribute
    if (dom_elements.nodes_list) {
      dom_elements.nodes_list.dataset.total = total_nodes;
    }

    // Update dashboard stats card (if visible)
    var dashboard_stat = document.getElementById("dashboard-stat-nodes");
    if (dashboard_stat) {
      dashboard_stat.textContent = total_nodes;
    }
  }

  /**
   * The attached device's node id, or null when the archive has not named one.
   * Server-rendered onto <body> rather than read off the stats poll, so the very
   * first message list can already say which rows are this device's own.
   */
  function get_local_node_id() {
    return dom_elements.body.dataset.localNodeId || null;
  }

  function get_node_url_template() {
    return dom_elements.body.dataset.apiNodeUrlTemplate || "/api/nodes/__NODE_ID__";
  }

  function build_node_url(node_id) {
    return get_node_url_template().replace("__NODE_ID__", encodeURIComponent(node_id));
  }

  function build_message_url(message_id, is_dm) {
    if (is_dm) {
      var dm_template = dom_elements.body.dataset.apiDmUrlTemplate || "/api/direct-messages/__MESSAGE_ID__";
      return dm_template.replace("__MESSAGE_ID__", encodeURIComponent(message_id));
    }
    var msg_template = dom_elements.body.dataset.apiMessageUrlTemplate || "/api/messages/__MESSAGE_ID__";
    return msg_template.replace("__MESSAGE_ID__", encodeURIComponent(message_id));
  }

  function format_timestamp(unix_timestamp) {
    if (!unix_timestamp) {
      return "";
    }
    var date = new Date(unix_timestamp * 1000);
    return date.toLocaleString();
  }

  function format_iso_timestamp(unix_timestamp) {
    if (!unix_timestamp) {
      return "";
    }
    var date = new Date(unix_timestamp * 1000);
    return date.toISOString();
  }

  /* 1755184620 becomes "8/14 11:17 AM". Mirrors format_time_short in
     mesh-console's ui/format.py — same seconds in, same string out, so when a
     conversation last moved reads identically in a browser and a terminal. The
     same arrangement format_uptime has with the same file, and kept in step the
     same way: by hand. hour12 is forced because strftime's %-I always is. */
  function format_time_short(unix_timestamp) {
    if (!unix_timestamp) {
      return "";
    }
    var date = new Date(unix_timestamp * 1000);
    var time = date.toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    return (date.getMonth() + 1) + "/" + date.getDate() + " " + time;
  }

  /* 90061 becomes "1d 1h 1m". Mirrors format_uptime in mesh-console's
     ui/format.py — same seconds in, same string out, so a node's uptime reads
     identically in a browser and a terminal. Units the count does not reach are
     dropped rather than printed as zero, and the seconds place only appears when
     it is the whole answer.

     Zero is a reading, not an absence: a device that rebooted a moment ago
     reports 0 and gets "0s". A node that has never reported uptime sends null,
     and apply_fields hides the row before this is ever called. */
  function format_uptime(seconds) {
    var total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) {
      return "";
    }

    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);

    var parts = [];
    if (days) { parts.push(days + "d"); }
    if (hours) { parts.push(hours + "h"); }
    if (minutes) { parts.push(minutes + "m"); }
    if (parts.length === 0) { parts.push((total % 60) + "s"); }

    return parts.join(" ");
  }

  /* Escape for a *text node*, and only for one.

     `<`, `>` and `&` come back escaped; `"` and `'` deliberately do not, because
     the browser does not escape them either — a quote inside text content is just
     a quote. That makes this correct for everything it is used for here, which is
     always content between tags, and wrong for an attribute value, where a `"`
     would close the attribute and everything after it would be markup.

     So: never `'<a href="' + escape_html(url) + '">'`. Build the element and use
     `setAttribute`, which escapes by construction — see `render_breadcrumbs`, which
     is where that lesson was learned. */
  function escape_html(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function format_node_display_name(node) {
    if (node.long_name && node.short_name) {
      return node.long_name + " (" + node.short_name + ")";
    }
    if (node.long_name) {
      return node.long_name;
    }
    if (node.short_name) {
      return node.short_name;
    }
    return node.node_id;
  }

  /**
   * Format node display name as HTML with spans for styling.
   * Returns HTML string with .node-long-name, .node-short-name, and/or .node-id spans.
   */
  function format_node_display_html(node) {
    var long_name = node.long_name || node.from_node_long_name;
    var short_name = node.short_name || node.from_node_short_name;
    var node_id = node.node_id || node.from_node;

    if (long_name && short_name) {
      return '<span class="node-long-name">' + escape_html(long_name) + '</span> ' +
             '<span class="node-short-name">(' + escape_html(short_name) + ')</span>';
    }
    if (long_name) {
      return '<span class="node-long-name">' + escape_html(long_name) + '</span>';
    }
    if (short_name) {
      return '<span class="node-short-name">' + escape_html(short_name) + '</span>';
    }
    if (node_id) {
      return '<span class="node-id">' + escape_html(node_id) + '</span>';
    }
    return '<span class="node-id">Unknown</span>';
  }


  /* ------------------------------------------
     Template Utilities (populate from JSON)
     ------------------------------------------ */

  /**
   * Access a nested value from an object using dot-notation path.
   * e.g., get_nested_value(data, "local_node.hardware")
   */
  function get_nested_value(obj, path) {
    return path.split(".").reduce(function(o, key) {
      return o != null ? o[key] : undefined;
    }, obj);
  }

  /**
   * Populate a DOM node (fragment or element) with data using a field map.
   *
   * Field map entries support:
   *   - selector: CSS selector to find the target element
   *   - format: optional function(value) -> formatted string
   *   - compute: optional function(data) -> derived value (skips dot-path lookup)
   *
   * When a value is null/empty and the target is inside a <tr>, the row is hidden.
   */
  function populate_fragment(container, data, field_map) {
    var entries = Object.entries(field_map);

    for (var i = 0; i < entries.length; i++) {
      var field = entries[i][0];
      var field_config = entries[i][1];

      var el = container.querySelector(field_config.selector);
      if (!el) continue;

      var value;
      if (field_config.compute) {
        value = field_config.compute(data);
      } else {
        value = get_nested_value(data, field);
      }

      if (value == null || value === "") {
        // Hide parent table row when value is missing
        var hidden_row = el.closest("tr");
        if (hidden_row) {
          hidden_row.setAttribute("hidden", "");
        }
        continue;
      }

      if (field_config.format) {
        value = field_config.format(value);
      }

      // Use innerHTML for HTML content, textContent for plain text
      if (field_config.html) {
        el.innerHTML = String(value);
      } else {
        el.textContent = String(value);
      }

      // Ensure row is visible if it was previously hidden
      var visible_row = el.closest("tr");
      if (visible_row) {
        visible_row.removeAttribute("hidden");
      }
    }
  }

  /**
   * Clone a <template> element and populate it with data using a field map.
   * Returns the populated DocumentFragment, or null if template not found.
   */
  function populate_template(template_id, data, field_map) {
    var template = document.getElementById(template_id);
    if (!template) return null;

    var clone = template.content.cloneNode(true);

    populate_fragment(clone, data, field_map);

    return clone;
  }

  /**
   * Update an already-rendered DOM element in-place using a field map.
   * Used for polling updates (dashboard stats, node detail).
   */
  function update_element(container, data, field_map) {
    if (!container) return;
    populate_fragment(container, data, field_map);
  }


  /* ------------------------------------------
     Field Maps (selector-based data binding)
     ------------------------------------------ */

  var field_maps = {

    dashboard: {
      "local_node.node_id": { selector: "[data-field='node-id']" },
      "local_node.hardware": { selector: "[data-field='hardware']" },
      "local_node.role": { selector: "[data-field='role']" },
      "local_node.first_seen": { selector: "[data-field='first-seen']", format: format_timestamp },
      "local_node.last_seen": { selector: "[data-field='last-seen']", format: format_timestamp },
      "local_node.battery_level": { selector: "[data-field='battery']", format: function(v) { return v + "%"; } },
      "local_node.voltage": { selector: "[data-field='voltage']", format: function(v) { return v + "V"; } },
      "stats.total_nodes": { selector: "#dashboard-stat-nodes" },
      "stats.total_messages": { selector: "#dashboard-stat-messages" },
      "stats.total_direct_messages": { selector: "#dashboard-stat-dms" },
      "stats.total_channels": { selector: "#dashboard-stat-channels" },
    },

    node_detail: {
      "node_id": { selector: "[data-field='node-id']" },
      "short_name": { selector: "[data-field='short-name']" },
      "long_name": { selector: "[data-field='long-name']" },
      "hardware": { selector: "[data-field='hardware']" },
      "role": { selector: "[data-field='role']" },
      "first_seen": { selector: "[data-field='first-seen']", format: format_timestamp },
      "last_seen": { selector: "[data-field='last-seen']", format: format_timestamp },
      "hops_away": { selector: "[data-field='hops-away']" },
      "battery_level": { selector: "[data-field='battery']", format: function(v) { return v + "%"; } },
      "voltage": { selector: "[data-field='voltage']", format: function(v) { return v + "V"; } },
      "snr": { selector: "[data-field='snr']" },
      "rssi": { selector: "[data-field='rssi']" },
      "latitude": { selector: "[data-field='latitude']" },
      "longitude": { selector: "[data-field='longitude']" },
      "altitude": { selector: "[data-field='altitude']", format: function(v) { return v + "m"; } },

      /* Schema 0.8.0's telemetry. Rounded here rather than in the query: the
         archive holds every digit the radio sent — 24.002031 is the real reading
         and mesh-collector's suite pins it — and a detail table is a label.
         mesh-console rounds the same six to the same places in its own panel.

         apply_fields above hides a row whose value is null or "", and a numeric
         zero is neither, so a channel utilization of 0.00% on a quiet mesh keeps
         its row while a node that never reported one has no row at all. */
      "temperature": { selector: "[data-field='temperature']", format: function(v) { return Number(v).toFixed(1) + "°C"; } },
      "humidity": { selector: "[data-field='humidity']", format: function(v) { return Number(v).toFixed(1) + "%"; } },
      "pressure": { selector: "[data-field='pressure']", format: function(v) { return Number(v).toFixed(1) + " hPa"; } },
      "channel_util": { selector: "[data-field='channel-util']", format: function(v) { return Number(v).toFixed(2) + "%"; } },
      "air_util_tx": { selector: "[data-field='air-util-tx']", format: function(v) { return Number(v).toFixed(2) + "%"; } },
      "uptime_seconds": { selector: "[data-field='uptime']", format: format_uptime },
    },

    message_item: {
      "_from_display": {
        selector: "[data-field='from-node']",
        compute: format_node_display_html,
        html: true,
      },
      "rx_time": { selector: "[data-field='rx-time']", format: format_timestamp },
      "text": { selector: "[data-field='text']" },
    },

    message_detail: {
      "message_id": { selector: "[data-field='message-id']" },
      "_from_display": {
        selector: "[data-field='from-node']",
        compute: format_node_display_html,
        html: true,
      },
      "to_node": { selector: "[data-field='to-node']" },
      "reply_to": { selector: "[data-field='reply-to']" },
      "text": { selector: "[data-field='text']" },
      "rx_time": { selector: "[data-field='rx-time']", format: format_timestamp },
      "_channel_display": {
        selector: "[data-field='channel']",
        compute: function(data) {
          return data.channel_name || (data.channel_index != null ? "Channel " + data.channel_index : null);
        },
      },
      "hop_count": { selector: "[data-field='hop-count']" },
      "snr": { selector: "[data-field='snr']" },
      "rssi": { selector: "[data-field='rssi']" },
      "_via_mqtt": {
        selector: "[data-field='via-mqtt']",
        compute: function(data) { return data.via_mqtt ? "Yes" : "No"; },
      },
    },

  };


  /* ------------------------------------------
     Scroll Preservation Utilities
     ------------------------------------------ */

  /**
   * Get scroll anchor info for a scrollable container.
   * Anchors on the first visible element (top-anchored).
   */
  function get_scroll_anchor(container) {
    if (!container) return null;

    var container_rect = container.getBoundingClientRect();
    var items = container.querySelectorAll("li");

    if (items.length === 0) return null;

    for (var i = 0; i < items.length; i++) {
      var item_rect = items[i].getBoundingClientRect();
      if (item_rect.top >= container_rect.top - 10) {
        return {
          element: items[i],
          offset_from_top: item_rect.top - container_rect.top,
        };
      }
    }

    return null;
  }

  /**
   * Restore scroll position based on anchor info.
   */
  function restore_scroll_anchor(container, anchor) {
    if (!container || !anchor || !anchor.element) return;

    if (!container.contains(anchor.element)) return;

    var container_rect = container.getBoundingClientRect();
    var item_rect = anchor.element.getBoundingClientRect();

    var current_offset = item_rect.top - container_rect.top;
    var adjustment = current_offset - anchor.offset_from_top;
    container.scrollTop += adjustment;
  }

  /**
   * Check if container is scrolled to top (within tolerance).
   */
  function is_at_scroll_top(container) {
    if (!container) return true;
    return container.scrollTop < 10;
  }


  /* ------------------------------------------
     Breadcrumb Reveal on Scroll-Up (Mobile)
     ------------------------------------------ */

  var BREADCRUMB_REVEAL_THRESHOLD = 80; // pixels of upward scroll before reveal

  /**
   * Handle window scroll for breadcrumb reveal behavior.
   * Shows breadcrumb bar when user scrolls up past threshold.
   * Only active on mobile (when body doesn't have breadcrumbs-sticky yet
   * or when we need to manage the sticky state).
   */
  function handle_breadcrumb_scroll() {
    var current_y = window.scrollY;
    var last_y = app_state.breadcrumb_last_scroll_y;
    var delta = current_y - last_y;

    // At top of page: reset everything, remove sticky immediately
    if (current_y <= 0) {
      app_state.breadcrumb_scroll_up_distance = 0;
      app_state.breadcrumb_scroll_down_distance = 0;
      app_state.breadcrumb_is_sticky = false;
      dom_elements.body.classList.remove("breadcrumbs-sticky", "breadcrumbs-hiding");
      app_state.breadcrumb_last_scroll_y = current_y;
      return;
    }

    // Scrolling down
    if (delta > 0) {
      // If breadcrumbs are visible, accumulate downward distance
      if (app_state.breadcrumb_is_sticky) {
        app_state.breadcrumb_scroll_down_distance += delta;
        app_state.breadcrumb_scroll_up_distance = 0;
    
        if (app_state.breadcrumb_scroll_down_distance >= BREADCRUMB_REVEAL_THRESHOLD) {
          app_state.breadcrumb_scroll_down_distance = 0;
          app_state.breadcrumb_is_sticky = false;
          dom_elements.body.classList.add("breadcrumbs-hiding");
        }
      }
      // If breadcrumbs are already hidden, reset counters and do nothing
      else {
        app_state.breadcrumb_scroll_up_distance = 0;
        app_state.breadcrumb_scroll_down_distance = 0;
      }
    }

    // Scrolling up: accumulate distance
    else if (delta < 0) {
      app_state.breadcrumb_scroll_up_distance += Math.abs(delta);
      app_state.breadcrumb_scroll_down_distance = 0;


      // Only reveal after crossing threshold (applies to both first-time and re-reveal)
      if (app_state.breadcrumb_scroll_up_distance >= BREADCRUMB_REVEAL_THRESHOLD) {
        // If hiding, reveal it again
        if (dom_elements.body.classList.contains("breadcrumbs-hiding")) {
          dom_elements.body.classList.remove("breadcrumbs-hiding");
          app_state.breadcrumb_is_sticky = true;
        }
        // First time showing: add sticky with initial off-screen position
        else if (!app_state.breadcrumb_is_sticky) {
          app_state.breadcrumb_is_sticky = true;
          // Start off-screen, then animate in
          dom_elements.body.classList.add("breadcrumbs-sticky", "breadcrumbs-hiding");
          // Force reflow so browser registers the initial state
          void dom_elements.body.offsetHeight;
          // Remove hiding to trigger slide-down animation
          dom_elements.body.classList.remove("breadcrumbs-hiding");
        }
      }
    }

    app_state.breadcrumb_last_scroll_y = current_y;
  }


  /* ------------------------------------------
     localStorage Read Tracking
     ------------------------------------------ */

  /**
   * Which conversation is on screen, or null if the view is not a message list.
   *
   * **One derivation, from `current_view` alone.** There was a second — an
   * `app_state.messages_is_dm` flag — and the two were set at different moments:
   * `current_view` and `current_channel_index` in show_channel_messages, the flag
   * several awaited fetches later inside render_messages_view. Between those the pair
   * disagreed, and a read position written in that window went under the previous
   * conversation's key. Deriving it means the two cannot drift, and it is one fewer
   * piece of state to keep in step by hand.
   *
   * The single-message view ("message") is not a list and has no read position; it
   * returns null here, and every caller treats that as "nothing to do". So is the
   * conversation index ("direct_messages"): its rows are threads, not messages,
   * and nothing on it can be scrolled past into being read — the thread views
   * under it each carry their own position.
   *
   * @returns {{ is_dm: boolean, channel_index: number|null, peer: string|null }|null}
   */
  function current_conversation() {
    if (app_state.current_view === "channel") {
      return { is_dm: false, channel_index: app_state.current_channel_index, peer: null };
    }
    if (app_state.current_view === "conversation") {
      return { is_dm: true, channel_index: null, peer: app_state.current_peer };
    }
    return null;
  }

  /**
   * Build a localStorage key for last-read tracking.
   * @param {boolean} is_dm - true for direct messages
   * @param {number|null} channel_index - channel index (ignored for DMs)
   * @param {string|null} peer - the conversation's peer node id (DMs only)
   * @returns {string} localStorage key
   */
  function build_last_read_key(is_dm, channel_index, peer) {
    if (is_dm) return "rxonly_last_read_dm_" + peer;
    return "rxonly_last_read_ch_" + channel_index;
  }

  /**
   * Get the last-read position for a channel or conversation.
   *
   * A conversation with no position of its own falls back to the legacy
   * "rxonly_last_read_dm" key, which is where the flat DM list — every
   * conversation at once — kept its one position before the view was threaded.
   * That is a floor, not a guess: a reader who had read the flat list up to some
   * moment had read every conversation up to it. Without the fallback, threading
   * would mark every old message unread again on the first visit after the
   * change. The legacy key is never written again; per-peer positions bury it
   * one conversation at a time.
   *
   * @returns {{ message_id: number, rx_time: number } | null}
   */
  function get_last_read(is_dm, channel_index, peer) {
    try {
      var key = build_last_read_key(is_dm, channel_index, peer);
      var raw = localStorage.getItem(key);
      if (!raw && is_dm) {
        raw = localStorage.getItem("rxonly_last_read_dm");
      }
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.message_id === "number" && typeof parsed.rx_time === "number") {
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save the last-read position for a channel/DM.
   *
   * Not called directly outside this block — go through advance_last_read, which is
   * where the "forward only" rule lives.
   */
  function set_last_read(is_dm, channel_index, peer, message_id, rx_time) {
    try {
      var key = build_last_read_key(is_dm, channel_index, peer);
      localStorage.setItem(key, JSON.stringify({ message_id: message_id, rx_time: rx_time }));
    } catch (e) {
      // Silently fail if localStorage is unavailable
    }
  }

  /**
   * Move a stored read position forward, and only forward.
   *
   * **The single place a read position is written.** There were three, with three
   * different rules — the threshold scan and the bottom-grace block each carried
   * their own copy of the comparison, and "Jump to newest" carried none at all and
   * could drag a position backwards. Three rules for one fact is why this mechanism
   * was hard to follow; this is the one rule.
   *
   * Returns whether it moved. Every caller gates its sidebar refresh on that, because
   * `update_channel_unread` re-reads localStorage for every channel in the list and
   * nothing but a moved position can change what it decides — and the scroll handler
   * calls into here undebounced, several times a second.
   *
   * **rx_time alone decides "forward",** which is the same comparison `has_unread` in
   * views.js and the GROUP BY in routes/api/stats.py make. `message_id` is the mesh
   * packet id — an arbitrary number from the sending radio — so ranking a tie by it
   * compares two unrelated numbers; the server stopped doing that and these had not.
   * It is still stored, because it is what identifies the row to anyone reading
   * localStorage by hand, but it decides nothing.
   *
   * What that gives up is the tie: a row arriving in the same whole second as the
   * stored position does not move it, and waits for the next second. rx_time has
   * one-second resolution, so this is routine — and it is a bounded, self-correcting
   * miss rather than a mark that cannot be cleared.
   */
  function advance_last_read(is_dm, channel_index, peer, message_id, rx_time) {
    if (!message_id || !rx_time) return false;
    var current = get_last_read(is_dm, channel_index, peer);
    if (current && rx_time <= current.rx_time) return false;
    set_last_read(is_dm, channel_index, peer, message_id, rx_time);
    return true;
  }

  /**
   * The newest inbound rx_time the sidebar is comparing this conversation against,
   * from the last poll — the very number `has_unread` is handed in views.js.
   *
   * Exists so that reaching the end of a list can mean "nothing is waiting" by
   * construction rather than by coincidence. The list does not draw one row per
   * archived row: a tapback with a parent is folded into a pill on that parent and
   * never becomes an `li`, so the newest row a reader can physically scroll past may
   * be older than the newest row the channel has. Anchoring the end-of-list position
   * to this number closes that gap for every folded row class at once, including the
   * legacy reactions routes/api/stats.py cannot filter in SQL.
   *
   * Null before the first poll has returned, and on a server that does not report the
   * field — in both cases the caller falls back to the newest drawn row, which is the
   * behaviour this had before.
   */
  function get_unread_ceiling(is_dm, channel_index, peer) {
    var stats = app_state.last_stats && app_state.last_stats.stats;
    if (!stats) return null;

    if (is_dm) {
      // Per peer since the DM view was threaded — the same map the sidebar's DM
      // entry sweeps in update_channel_unread, read for one thread.
      var by_peer = stats.peer_newest_inbound_rx_time;
      if (!by_peer || !peer) return null;
      var dm_newest = by_peer[peer];
      return typeof dm_newest === "number" ? dm_newest : null;
    }

    var by_channel = stats.channel_newest_inbound_rx_time;
    if (!by_channel) return null;
    var newest = by_channel[channel_index];
    return typeof newest === "number" ? newest : null;
  }

  /**
   * Scan visible messages and update last-read based on viewport bottom edge.
   * A message is considered "read" when its top edge is inside the visible
   * area of the messages list container (i.e. the user can see it).
   * Also marks qualifying items with the "message-read" class.
   */
  function update_read_position() {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    // Resolved once, at the top, and both branches below write under it. Reading the
    // conversation separately per write was how a position could be written under one
    // key having been decided against another.
    var conversation = current_conversation();
    if (!conversation) return;

    // Whether this pass actually moved the stored position. Both branches below can
    // move it, and the sidebar is refreshed once at the end if either did — see the
    // note there for why this is gated rather than called unconditionally.
    var advanced = false;

    var container_rect = messages_list.getBoundingClientRect();

    // Use the lesser of the container bottom and the viewport bottom so that
    // this works correctly on both desktop (container scrolls internally) and
    // mobile (container overflows, window scrolls).
    var effective_bottom = Math.min(container_rect.bottom, window.innerHeight);
    var visible_height = effective_bottom - container_rect.top;
    var bottom_y = effective_bottom - (visible_height * config.read_threshold_ratio);

    var items = messages_list.querySelectorAll("li[data-message-id]");
    var last_read_item = null;

    for (var i = 0; i < items.length; i++) {
      var item_rect = items[i].getBoundingClientRect();
      // Message is "read" if its top is above the read threshold line
      if (item_rect.top < bottom_y) {
        last_read_item = items[i];
        // Mark as read in the DOM
        mark_message_read(items[i]);
      } else {
        break; // Items are in ASC order, no need to check further
      }
    }

    if (last_read_item) {
      var msg_id = parseInt(last_read_item.dataset.messageId, 10);
      var rx_time = parseInt(last_read_item.dataset.rxTime || "0", 10);
      if (advance_last_read(conversation.is_dm, conversation.channel_index, conversation.peer, msg_id, rx_time)) {
        advanced = true;
      }
    }

    // Bottom grace: when there are no newer messages to load and the user has
    // scrolled to within 16vh of the absolute end of the list, mark everything
    // as read. This handles the case where the last few messages can never
    // reach the threshold because there is nothing to scroll past.
    if (!app_state.messages_has_more_newer) {
      var is_mobile = getComputedStyle(messages_list).overflowY === "visible";
      var scroll_bottom_gap;
      if (is_mobile) {
        scroll_bottom_gap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      } else {
        scroll_bottom_gap = messages_list.scrollHeight - (messages_list.scrollTop + messages_list.clientHeight);
      }

      if (scroll_bottom_gap <= window.innerHeight * 0.16) {
        var all_items = messages_list.querySelectorAll("li[data-message-id]");
        var newest_item = null;
        for (var j = 0; j < all_items.length; j++) {
          mark_message_read(all_items[j]);
          newest_item = all_items[j];
        }
        if (newest_item) {
          var newest_id = parseInt(newest_item.dataset.messageId, 10);
          var newest_rx_time = parseInt(newest_item.dataset.rxTime || "0", 10);

          // **The end of the list is past every folded row too, not just every drawn
          // one.** A tapback attached to the last message sits above it in time and
          // is never an `li`, so storing the last `li`'s rx_time here left the
          // sidebar comparing against a number this branch could never reach — the
          // channel stayed bold no matter how often it was read. Taking the ceiling
          // the sidebar itself is using makes "read to the end" and "nothing waiting"
          // the same statement, for any row the list decides not to draw.
          //
          // Only in this branch: it is guarded by `!messages_has_more_newer` and a
          // scroll to the absolute bottom, so there is genuinely nothing left to
          // reach. The threshold scan above must keep using the row it is looking at.
          var ceiling = get_unread_ceiling(conversation.is_dm, conversation.channel_index, conversation.peer);
          if (ceiling !== null && ceiling > newest_rx_time) {
            newest_rx_time = ceiling;
          }

          if (advance_last_read(conversation.is_dm, conversation.channel_index, conversation.peer, newest_id, newest_rx_time)) {
            advanced = true;
          }
        }
      }
    }

    // The channel being read stops looking unread the moment it is read, rather than
    // at the next fast poll or — as it was — only once the reader navigated away.
    // Scrolling to the bottom of a channel is exactly what the grace block above
    // treats as reading all of it, so that is the moment the sidebar has to agree.
    //
    // **Gated on the position having moved, because this runs on every scroll event.**
    // `handle_messages_scroll` calls it undebounced — the debounce there is only for
    // the poll-pause flag — so an unconditional refresh would re-read localStorage for
    // every channel several times a second while a reader scrolls. Nothing can change
    // the unread state but the position moving, so nothing else needs to trigger it.
    //
    // refresh_channel_unread is defined in views.js; safe to call at runtime since all
    // files are loaded before any user interaction — the same reasoning as the
    // clear_pending_tapbacks call further down.
    if (advanced) {
      RxOnly.refresh_channel_unread();
    }
  }

  /**
   * Mark a single message list item as read.
   */
  function mark_message_read(li) {
    if (!li.classList.contains("message-read")) {
      li.classList.remove("message-unread");
      li.classList.add("message-read");
    }
  }

  /**
   * Stamp every row at or before a stored read position as read. Used at render time,
   * so that a channel reopened from a saved position does not come back all-unread.
   *
   * **`rx_time` alone, and `<=`** — the same comparison advance_last_read and
   * has_unread make, so that every test in this mechanism can be read as the same
   * test. It was `rx < stored.rx_time || (rx === stored.rx_time && mid <= stored
   * .message_id)`, ranking a tie by the mesh packet id, which is not an ordering.
   * Within one second — routine at rx_time's resolution — that left rows already read
   * unstamped, and `scroll_to_first_unread_at_threshold` then took the first of them
   * as the first unread message and scrolled the reader back to something they had
   * already seen.
   *
   * Rows sharing the stored second are now stamped read. The position was set from a
   * row in that second, so at worst this over-reaches by under a second, and it
   * over-reaches towards "read" — the direction that resolves itself rather than the
   * one that leaves a mark nobody can clear.
   *
   * @param {HTMLElement} messages_ul - The UL element
   * @param {{ message_id: number, rx_time: number }|null} last_read - Stored position
   */
  function mark_read_up_to(messages_ul, last_read) {
    if (!last_read) return;

    var items = messages_ul.querySelectorAll("li[data-message-id]");
    for (var i = 0; i < items.length; i++) {
      var rx = parseInt(items[i].dataset.rxTime || "0", 10);
      if (rx <= last_read.rx_time) {
        mark_message_read(items[i]);
      }
    }
  }

  /**
   * Save the current read position and scroll offset before leaving a messages view.
   * Call this before switching away from a channel/DM view to ensure
   * the read position is persisted even if the user never scrolled.
   */
  function save_read_position_before_leave() {
    var conversation = current_conversation();
    if (!conversation) return;

    // `update_read_position` refreshes the sidebar itself when it moves the position,
    // so there is no separate refresh here. There was one, hooked at this level, and
    // that was the bug: leaving a view is the *last* moment a channel stops being
    // unread, not the first, so a reader who scrolled to the bottom of a channel
    // watched its count stay bold until they navigated somewhere else.
    update_read_position();

    // Save scroll position for restoration when returning.
    // On desktop the messages list scrolls; on mobile the window scrolls.
    var messages_list = document.getElementById("messages-list");
    if (messages_list) {
      var is_mobile = getComputedStyle(messages_list).overflowY === "visible";
      var scroll_pos = is_mobile ? window.scrollY : messages_list.scrollTop;
      if (scroll_pos > 0) {
        app_state.saved_messages_scroll_top = scroll_pos;
        app_state.saved_messages_is_mobile = is_mobile;
        app_state.saved_messages_channel_index = conversation.channel_index;
        app_state.saved_messages_is_dm = conversation.is_dm;
        app_state.saved_messages_peer = conversation.peer;
      }
    }
  }

  /**
   * Clear saved scroll position. Call when the saved position is consumed
   * or no longer relevant.
   */
  function clear_saved_scroll_position() {
    app_state.saved_messages_scroll_top = null;
    app_state.saved_messages_is_mobile = false;
    app_state.saved_messages_channel_index = null;
    app_state.saved_messages_is_dm = false;
    app_state.saved_messages_peer = null;
  }

  /**
   * Check whether a saved scroll position matches the given channel/conversation.
   * @param {boolean} is_dm
   * @param {number|null} channel_index
   * @param {string|null} peer
   * @returns {{ scroll_top: number, is_mobile: boolean }|null} Saved position, or null if no match
   */
  function consume_saved_scroll_position(is_dm, channel_index, peer) {
    if (app_state.saved_messages_scroll_top === null) return null;
    if (app_state.saved_messages_is_dm !== is_dm) {
      clear_saved_scroll_position();
      return null;
    }
    if (!is_dm && app_state.saved_messages_channel_index !== channel_index) {
      clear_saved_scroll_position();
      return null;
    }
    if (is_dm && app_state.saved_messages_peer !== peer) {
      clear_saved_scroll_position();
      return null;
    }
    var result = {
      scroll_top: app_state.saved_messages_scroll_top,
      is_mobile: app_state.saved_messages_is_mobile,
    };
    clear_saved_scroll_position();
    return result;
  }


  /* ------------------------------------------
     API Functions
     ------------------------------------------ */

  function get_nodes_list_url() {
    return dom_elements.body.dataset.apiNodesUrl || "/api/nodes";
  }

  function get_stats_url() {
    return dom_elements.body.dataset.apiStatsUrl || "/api/stats";
  }

  function get_direct_messages_url() {
    return get_nodes_list_url().replace("/nodes", "/direct-messages");
  }

  function get_dm_conversations_url() {
    return dom_elements.body.dataset.apiDmConversationsUrl || "/api/direct-messages/conversations";
  }

  /**
   * Fetch the direct message index: one entry per peer, newest thread first,
   * with the local node's names riding along for the rows' left-hand side.
   */
  function fetch_conversations() {
    return fetch(get_dm_conversations_url()).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch conversations: " + response.status);
      }
      return response.json();
    });
  }

  function fetch_nodes_page(offset, limit, search) {
    var base_url = get_nodes_list_url();
    var url = base_url + "?offset=" + offset + "&limit=" + limit;
    if (search) {
      url += "&search=" + encodeURIComponent(search);
    }
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch nodes: " + response.status);
      }
      return response.json();
    });
  }

  function fetch_stats() {
    var url = get_stats_url();
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch stats: " + response.status);
      }
      return response.json();
    });
  }

  /**
   * Unified fetch for messages and direct messages with cursor support.
   * @param {Object} options
   * @param {boolean} options.is_dm - Fetch direct messages instead of channel messages
   * @param {number|null} [options.channel_index] - Channel index (ignored for DMs)
   * @param {string|null} [options.peer] - Narrow DMs to one conversation (ignored for channels)
   * @param {number|null} [options.after_rx_time] - Load messages after this timestamp
   * @param {number|null} [options.after_id] - Row id at that second, the cursor's other half
   * @param {number|null} [options.before_rx_time] - Load messages before this timestamp
   * @param {number|null} [options.before_id] - Row id at that second, the cursor's other half
   * @param {boolean} [options.newest] - Load the newest page
   * @param {number} [options.limit=50] - Page size
   * @returns {Promise<Object>} API response with meta + messages/direct_messages
   */
  function fetch_message_page(options) {
    var is_dm = options.is_dm || false;
    var base_url = is_dm ? get_direct_messages_url() : get_nodes_list_url().replace("/nodes", "/messages");
    var params = new URLSearchParams();

    if (!is_dm && options.channel_index != null) {
      params.set("channel_index", String(options.channel_index));
    }
    if (is_dm && options.peer) {
      params.set("peer", options.peer);
    }
    // A cursor is the (rx_time, id) pair. rx_time is whole seconds off the mesh, so
    // two messages routinely share one and a page that ends inside a tie has to say
    // which row of it it ended on — a timestamp alone asks for everything older than
    // the whole second and steps over the rest of it. The id is sent separately
    // rather than as a packed cursor because the bare timestamp form still works and
    // old bookmarks carry it.
    if (options.after_rx_time != null) {
      params.set("after_rx_time", String(options.after_rx_time));
      if (options.after_id != null) {
        params.set("after_id", String(options.after_id));
      }
    }
    if (options.before_rx_time != null) {
      params.set("before_rx_time", String(options.before_rx_time));
      if (options.before_id != null) {
        params.set("before_id", String(options.before_id));
      }
    }
    if (options.newest) {
      params.set("newest", "1");
    }
    params.set("limit", String(options.limit || 50));

    var url = base_url + "?" + params.toString();
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch " + (is_dm ? "direct messages" : "messages") + ": " + response.status);
      }
      return response.json();
    });
  }

  /**
   * Update app_state cursor fields from an API response.
   * Call after every successful fetch_message_page.
   */
  function update_message_cursors(data, is_dm) {
    var messages = is_dm ? data.direct_messages : data.messages;
    app_state.messages_has_more_older = data.meta.has_more_older;
    app_state.messages_has_more_newer = data.meta.has_more_newer;
    app_state.messages_total = data.meta.total;

    if (messages.length > 0) {
      var first = messages[0];
      var last = messages[messages.length - 1];
      // Only update oldest cursors if these are actually older
      if (app_state.messages_oldest_rx_time === null || first.rx_time < app_state.messages_oldest_rx_time
          || (first.rx_time === app_state.messages_oldest_rx_time && first.id < app_state.messages_oldest_id)) {
        app_state.messages_oldest_rx_time = first.rx_time;
        app_state.messages_oldest_id = first.id;
      }
      // Only update newest cursors if these are actually newer
      if (app_state.messages_newest_rx_time === null || last.rx_time > app_state.messages_newest_rx_time
          || (last.rx_time === app_state.messages_newest_rx_time && last.id > app_state.messages_newest_id)) {
        app_state.messages_newest_rx_time = last.rx_time;
        app_state.messages_newest_id = last.id;
      }
    }
  }

  /**
   * Reset message pagination state. Call when switching channels/views.
   */
  function reset_message_state() {
    app_state.messages_has_more_older = false;
    app_state.messages_has_more_newer = false;
    app_state.messages_is_loading = false;
    app_state.messages_oldest_rx_time = null;
    app_state.messages_newest_rx_time = null;
    app_state.messages_oldest_id = null;
    app_state.messages_newest_id = null;
    app_state.messages_total = 0;
    // clear_pending_tapbacks is defined in messages.js; safe to call
    // at runtime since all files are loaded before any user interaction.
    RxOnly.clear_pending_tapbacks();
  }


  /* ------------------------------------------
     Breadcrumb Functions
     ------------------------------------------ */

  /* Built with DOM calls rather than by concatenating markup, which is what every
     other renderer here does and is why this was the odd one out.

     `crumb.href` and `crumb.view` were being interpolated straight into `href="..."`
     and `data-view="..."`, and `escape_html` could not have covered them anyway:
     it escapes for a *text node* — `div.textContent = s; return div.innerHTML` —
     which leaves `"` alone, because a quote in text is just a quote. Inside an
     attribute a quote closes it. So the label was safe and the two attributes were
     not, and the only reason nothing has gone wrong is that today's hrefs happen to
     come from `getAttribute("href")` on server-rendered links and from
     `encodeURIComponent`. That is a fact about the callers, not a property of this
     function, and it was one caller away from being untrue.

     `setAttribute` and `textContent` escape by construction, so there is nothing
     left to remember. */
  function render_breadcrumbs() {
    var list = dom_elements.breadcrumbs_list;
    list.textContent = "";

    app_state.breadcrumbs.forEach(function(crumb, index) {
      var item = document.createElement("li");
      var link = document.createElement("a");

      link.setAttribute("href", crumb.href);
      link.setAttribute("data-view", crumb.view);
      if (index === app_state.breadcrumbs.length - 1) {
        link.setAttribute("aria-current", "page");
      }
      link.textContent = crumb.label;

      item.appendChild(link);
      list.appendChild(item);
    });
  }

  function set_breadcrumbs(crumbs) {
    app_state.breadcrumbs = crumbs;
    render_breadcrumbs();
  }


  /* ------------------------------------------
     Sidebar Active State
     ------------------------------------------ */

  /**
   * Remove .active class from all sidebar links.
   */
  function clear_sidebar_active() {
    var active_links = document.querySelectorAll(".channel-link.active, .node-link.active");
    for (var i = 0; i < active_links.length; i++) {
      active_links[i].classList.remove("active");
    }
  }


  /* ------------------------------------------
     Namespace Exports
     ------------------------------------------ */

  // Shared data
  RxOnly.config = config;
  RxOnly.app_state = app_state;
  RxOnly.dom_elements = dom_elements;
  RxOnly.field_maps = field_maps;

  // Utilities
  RxOnly.update_page_title = update_page_title;
  RxOnly.update_all_node_counts = update_all_node_counts;
  RxOnly.format_timestamp = format_timestamp;
  RxOnly.format_iso_timestamp = format_iso_timestamp;
  RxOnly.format_time_short = format_time_short;
  RxOnly.escape_html = escape_html;
  RxOnly.get_local_node_id = get_local_node_id;
  RxOnly.build_node_url = build_node_url;
  RxOnly.build_message_url = build_message_url;
  RxOnly.format_node_display_name = format_node_display_name;
  RxOnly.format_node_display_html = format_node_display_html;

  // Template engine
  RxOnly.get_nested_value = get_nested_value;
  RxOnly.populate_template = populate_template;
  RxOnly.populate_fragment = populate_fragment;
  RxOnly.update_element = update_element;

  // Scroll preservation
  RxOnly.get_scroll_anchor = get_scroll_anchor;
  RxOnly.restore_scroll_anchor = restore_scroll_anchor;
  RxOnly.is_at_scroll_top = is_at_scroll_top;
  RxOnly.handle_breadcrumb_scroll = handle_breadcrumb_scroll;

  // Read tracking
  RxOnly.current_conversation = current_conversation;
  RxOnly.get_last_read = get_last_read;
  RxOnly.advance_last_read = advance_last_read;
  RxOnly.get_unread_ceiling = get_unread_ceiling;
  RxOnly.update_read_position = update_read_position;
  RxOnly.mark_message_read = mark_message_read;
  RxOnly.mark_read_up_to = mark_read_up_to;
  RxOnly.save_read_position_before_leave = save_read_position_before_leave;
  RxOnly.clear_saved_scroll_position = clear_saved_scroll_position;
  RxOnly.consume_saved_scroll_position = consume_saved_scroll_position;

  // API
  RxOnly.get_nodes_list_url = get_nodes_list_url;
  RxOnly.get_stats_url = get_stats_url;
  RxOnly.get_direct_messages_url = get_direct_messages_url;
  RxOnly.fetch_nodes_page = fetch_nodes_page;
  RxOnly.fetch_stats = fetch_stats;
  RxOnly.fetch_conversations = fetch_conversations;
  RxOnly.fetch_message_page = fetch_message_page;
  RxOnly.update_message_cursors = update_message_cursors;
  RxOnly.reset_message_state = reset_message_state;

  // Breadcrumbs
  RxOnly.set_breadcrumbs = set_breadcrumbs;

  // Sidebar active state
  RxOnly.clear_sidebar_active = clear_sidebar_active;

})();
