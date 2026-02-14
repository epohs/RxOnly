-- schema_version: 0.5.5


-- -------------------
-- Meta table
-- -------------------
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- -------------------
-- Nodes table
-- -------------------
CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY,
    short_name TEXT,
    long_name TEXT,
    hardware TEXT,
    role TEXT,
    first_seen INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen INTEGER,
    battery_level INTEGER,
    voltage REAL,
    snr REAL,
    rssi REAL,
    latitude REAL,
    longitude REAL,
    altitude REAL
);

-- Index to quickly find active nodes by last_seen
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen
ON nodes (last_seen);


-- -------------------
-- Channels table
-- -------------------
CREATE TABLE IF NOT EXISTS channels (
    channel_index INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);


-- -------------------
-- Channel messages table
-- -------------------
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER UNIQUE,
    channel_index INTEGER,
    from_node TEXT,
    to_node TEXT,
    text TEXT,
    rx_time INTEGER,
    hop_count INTEGER,
    snr REAL,
    rssi REAL,
    reply_to INTEGER,
    via_mqtt INTEGER DEFAULT 0
);

-- Covering index for channel message lists (filter, order, JOIN keys)
CREATE INDEX IF NOT EXISTS idx_messages_channel_covering
ON messages (channel_index, rx_time DESC, id, message_id, from_node, reply_to, via_mqtt);

-- Reply-to JOIN optimization
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
ON messages (reply_to);


-- -------------------
-- Direct messages table
-- -------------------
CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER UNIQUE,
    from_node TEXT,
    text TEXT,
    rx_time INTEGER,
    snr REAL,
    rssi REAL,
    reply_to INTEGER,
    via_mqtt INTEGER DEFAULT 0
);

-- Covering index for DM lists (order, JOIN keys)
CREATE INDEX IF NOT EXISTS idx_dms_covering
ON direct_messages (rx_time DESC, id, message_id, from_node, reply_to, via_mqtt);

-- Reply-to JOIN optimization
CREATE INDEX IF NOT EXISTS idx_dms_reply_to
ON direct_messages (reply_to);
