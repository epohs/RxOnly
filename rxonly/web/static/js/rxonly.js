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
  };


  /* ------------------------------------------
     State
     ------------------------------------------ */

  var app_state = {
    current_view: "home",  // "home", "channel", "node", "direct_messages", "message"
    current_channel_index: null,
    current_channel_name: null,
    current_channel_url: null,
    current_node_url: null,
    breadcrumbs: [{ label: "Dashboard", href: "/", view: "home" }],
    is_loading_more_nodes: false,

    // Previous view context (for breadcrumb navigation)
    previous_view: null,
    previous_channel_index: null,
    previous_channel_name: null,
    previous_channel_url: null,

    // Polling state
    fast_poll_timer: null,
    slow_poll_timer: null,
    poll_failure_count: 0,
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
    messages_is_dm: false,
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
      "battery_level": { selector: "[data-field='battery']", format: function(v) { return v + "%"; } },
      "voltage": { selector: "[data-field='voltage']", format: function(v) { return v + "V"; } },
      "snr": { selector: "[data-field='snr']" },
      "rssi": { selector: "[data-field='rssi']" },
      "latitude": { selector: "[data-field='latitude']" },
      "longitude": { selector: "[data-field='longitude']" },
      "altitude": { selector: "[data-field='altitude']", format: function(v) { return v + "m"; } },
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
   * Build a localStorage key for last-read tracking.
   * @param {boolean} is_dm - true for direct messages
   * @param {number|null} channel_index - channel index (ignored for DMs)
   * @returns {string} localStorage key
   */
  function build_last_read_key(is_dm, channel_index) {
    if (is_dm) return "rxonly_last_read_dm";
    return "rxonly_last_read_ch_" + channel_index;
  }

  /**
   * Get the last-read position for a channel/DM.
   * @returns {{ message_id: number, rx_time: number } | null}
   */
  function get_last_read(is_dm, channel_index) {
    try {
      var key = build_last_read_key(is_dm, channel_index);
      var raw = localStorage.getItem(key);
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
   */
  function set_last_read(is_dm, channel_index, message_id, rx_time) {
    try {
      var key = build_last_read_key(is_dm, channel_index);
      localStorage.setItem(key, JSON.stringify({ message_id: message_id, rx_time: rx_time }));
    } catch (e) {
      // Silently fail if localStorage is unavailable
    }
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

    var container_rect = messages_list.getBoundingClientRect();
    var bottom_y = container_rect.bottom;

    var items = messages_list.querySelectorAll("li[data-message-id]");
    var last_read_item = null;

    for (var i = 0; i < items.length; i++) {
      var item_rect = items[i].getBoundingClientRect();
      // Message is "read" if its top is above the bottom of the visible area
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
      if (msg_id && rx_time) {
        var current = get_last_read(app_state.messages_is_dm, app_state.current_channel_index);
        // Only update if this message is newer than the stored one
        if (!current || rx_time > current.rx_time || (rx_time === current.rx_time && msg_id > current.message_id)) {
          set_last_read(app_state.messages_is_dm, app_state.current_channel_index, msg_id, rx_time);
        }
      }
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
   * Mark all messages in the list as read up to (and including) the given
   * message_id / rx_time. Used at render time to stamp already-read items.
   * @param {HTMLElement} messages_ul - The UL element
   * @param {{ message_id: number, rx_time: number }|null} last_read - Stored position
   */
  function mark_read_up_to(messages_ul, last_read) {
    if (!last_read) return;

    var items = messages_ul.querySelectorAll("li[data-message-id]");
    for (var i = 0; i < items.length; i++) {
      var rx = parseInt(items[i].dataset.rxTime || "0", 10);
      var mid = parseInt(items[i].dataset.messageId, 10);
      if (rx < last_read.rx_time || (rx === last_read.rx_time && mid <= last_read.message_id)) {
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
    if (app_state.current_view !== "channel" && app_state.current_view !== "direct_messages") return;

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
        app_state.saved_messages_channel_index = app_state.current_channel_index;
        app_state.saved_messages_is_dm = app_state.current_view === "direct_messages";
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
  }

  /**
   * Check whether a saved scroll position matches the given channel/DM context.
   * @param {boolean} is_dm
   * @param {number|null} channel_index
   * @returns {{ scroll_top: number, is_mobile: boolean }|null} Saved position, or null if no match
   */
  function consume_saved_scroll_position(is_dm, channel_index) {
    if (app_state.saved_messages_scroll_top === null) return null;
    if (app_state.saved_messages_is_dm !== is_dm) {
      clear_saved_scroll_position();
      return null;
    }
    if (!is_dm && app_state.saved_messages_channel_index !== channel_index) {
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
   * @param {number|null} [options.after_rx_time] - Load messages after this timestamp
   * @param {number|null} [options.before_rx_time] - Load messages before this timestamp
   * @param {boolean} [options.newest] - Load the newest page
   * @param {number} [options.limit=50] - Page size
   * @returns {Promise<Object>} API response with meta + messages/direct_messages
   */
  function fetch_message_page(options) {
    var is_dm = options.is_dm || false;
    var base_url = get_nodes_list_url().replace("/nodes", is_dm ? "/direct-messages" : "/messages");
    var params = new URLSearchParams();

    if (!is_dm && options.channel_index != null) {
      params.set("channel_index", String(options.channel_index));
    }
    if (options.after_rx_time != null) {
      params.set("after_rx_time", String(options.after_rx_time));
    }
    if (options.before_rx_time != null) {
      params.set("before_rx_time", String(options.before_rx_time));
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

  function render_breadcrumbs() {
    var breadcrumbs_html = app_state.breadcrumbs.map(function(crumb, index) {
      var is_current = index === app_state.breadcrumbs.length - 1;
      if (is_current) {
        return '<li><a href="' + crumb.href + '" aria-current="page" data-view="' + crumb.view + '">' + escape_html(crumb.label) + '</a></li>';
      }
      return '<li><a href="' + crumb.href + '" data-view="' + crumb.view + '">' + escape_html(crumb.label) + '</a></li>';
    }).join("");

    dom_elements.breadcrumbs_list.innerHTML = breadcrumbs_html;
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
  RxOnly.escape_html = escape_html;
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
  RxOnly.get_last_read = get_last_read;
  RxOnly.set_last_read = set_last_read;
  RxOnly.update_read_position = update_read_position;
  RxOnly.mark_message_read = mark_message_read;
  RxOnly.mark_read_up_to = mark_read_up_to;
  RxOnly.save_read_position_before_leave = save_read_position_before_leave;
  RxOnly.clear_saved_scroll_position = clear_saved_scroll_position;
  RxOnly.consume_saved_scroll_position = consume_saved_scroll_position;

  // API
  RxOnly.get_nodes_list_url = get_nodes_list_url;
  RxOnly.get_stats_url = get_stats_url;
  RxOnly.fetch_nodes_page = fetch_nodes_page;
  RxOnly.fetch_stats = fetch_stats;
  RxOnly.fetch_message_page = fetch_message_page;
  RxOnly.update_message_cursors = update_message_cursors;
  RxOnly.reset_message_state = reset_message_state;

  // Breadcrumbs
  RxOnly.set_breadcrumbs = set_breadcrumbs;

  // Sidebar active state
  RxOnly.clear_sidebar_active = clear_sidebar_active;

})();
