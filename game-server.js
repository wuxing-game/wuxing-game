var http = require('http');
var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');

var PORT = 3002;
var rooms = {};
var clients = {};
var nextCid = 1;

var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'tianyun-game.html'), function(err, data) {
      if (err) {
        res.writeHead(500);
        res.end('Error loading tianyun-game.html');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate'});
      res.end(data);
    });
  } else if (url === '/board.png') {
    fs.readFile(path.join(__dirname, 'board.png'), function(err, data) {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-cache'});
      res.end(data);
    });
  } else if (url === '/tianyun-simple.html') {
    fs.readFile(path.join(__dirname, 'tianyun-simple.html'), function(err, data) {
      if (err) {
        res.writeHead(500);
        res.end('Error loading tianyun-simple.html');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate'});
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

var wss = new WebSocket.Server({server: server});

wss.on('connection', function(ws) {
  var cid = nextCid++;
  console.log('[SERVER] Client connected: ' + cid);
  clients[cid] = { socket: ws, room: null, role: null };
  
  ws.on('message', function(data) {
    try {
      var msg = JSON.parse(data.toString());
      console.log('[SERVER] Received:', msg.type, 'from cid:', cid);
      handleGameMessage(cid, msg, ws);
    } catch (e) {
      console.log('[SERVER] JSON parse error:', e.message);
    }
  });
  
  ws.on('close', function() {
    console.log('[SERVER] Client disconnected: ' + cid);
    if (clients[cid] && clients[cid].room) {
      var r = rooms[clients[cid].room];
      if (r) {
        // Notify other player
        var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
        console.log('[SERVER] Disconnect: otherCid=' + otherCid + ', hostCid=' + r.hostCid + ', guestCid=' + r.guestCid);
        if (otherCid && clients[otherCid]) {
          console.log('[SERVER] Sending opponent_left to cid=' + otherCid + ', socket.readyState=' + clients[otherCid].socket.readyState);
          try {
            clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
            console.log('[SERVER] opponent_left sent OK to cid=' + otherCid);
          } catch(e) {
            console.log('[SERVER] ERROR sending opponent_left: ' + e.message);
          }
        } else {
          console.log('[SERVER] No other player to notify (otherCid=' + otherCid + ', clients[otherCid]=' + (clients[otherCid] ? 'exists' : 'null') + ')');
        }
        // Clean up room
        delete rooms[clients[cid].room];
      }
    }
    delete clients[cid];
  });
  
  ws.on('error', function(err) {
    console.log('[SERVER] WebSocket error:', err.message);
  });
});

function handleGameMessage(cid, msg, ws) {
  var type = msg.type;
  var roomCode = msg.roomCode || msg.rc;
  
  if (type === 'create_room' || type === 'cr') {
    var rc = String(roomCode || '');
    if (rc.length !== 4 || isNaN(rc)) {
      ws.send(JSON.stringify({type: 'error', message: '房间号必须是4位数字'}));
      return;
    }
    if (rooms[rc]) {
      ws.send(JSON.stringify({type: 'error', message: '房间号已存在'}));
      return;
    }
    rooms[rc] = { hostCid: cid, guestCid: null, ts: Date.now() };
    clients[cid].room = rc;
    clients[cid].role = 'host';
    ws.send(JSON.stringify({type: 'room_created', roomCode: rc}));
    console.log('[SERVER] Room created:', rc, 'by cid:', cid);
  }
  else if (type === 'join_room' || type === 'jr') {
    var code = String(roomCode || '');
    if (!rooms[code]) {
      ws.send(JSON.stringify({type: 'error', message: '房间不存在或已关闭'}));
      return;
    }
    if (rooms[code].guestCid) {
      ws.send(JSON.stringify({type: 'error', message: '房间已满'}));
      return;
    }
    rooms[code].guestCid = cid;
    rooms[code].ts = Date.now();
    clients[cid].room = code;
    clients[cid].role = 'guest';
    
    // Tell guest they joined
    ws.send(JSON.stringify({type: 'room_joined'}));
    
    // Tell host a guest joined
    var hostC = clients[rooms[code].hostCid];
    if (hostC && hostC.socket.readyState === WebSocket.OPEN) {
      hostC.socket.send(JSON.stringify({type: 'guest_joined'}));
    }
    console.log('[SERVER] Guest joined room:', code, 'cid:', cid);
  }
  else if (type === 'game_data' || type === 'gd') {
    // 转发 game_data 包装中的实际数据（move、game_start、restart 等）
    var inner = msg.data;
    if (!inner || !inner.type) return;
    if (!clients[cid].room || !rooms[clients[cid].room]) return;
    var r = rooms[clients[cid].room];
    var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
    if (otherCid && clients[otherCid] && clients[otherCid].socket.readyState === WebSocket.OPEN) {
      clients[otherCid].socket.send(JSON.stringify({type:'game_data', data:inner}));
    }
  }
  else if (type === 'cancel_room' || type === 'cancelR') {
    if (!clients[cid].room) return;
    var r = rooms[clients[cid].room];
    if (r) {
      var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
      if (otherCid && clients[otherCid]) {
        clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
      }
    }
    delete rooms[clients[cid].room];
    clients[cid].room = null;
    clients[cid].role = null;
    console.log('[SERVER] Room cancelled:', clients[cid].room);
  }
  else if (type === 'leave_room' || type === 'leaveR') {
    if (!clients[cid].room) return;
    var r = rooms[clients[cid].room];
    if (r) {
      var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
      if (otherCid && clients[otherCid]) {
        clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
      }
      // Clean up room
      if (r.hostCid === cid) { r.hostCid = r.guestCid; r.guestCid = null; }
      else if (r.guestCid === cid) { r.guestCid = null; }
      if (!r.hostCid && !r.guestCid) delete rooms[clients[cid].room];
    }
    clients[cid].room = null;
    clients[cid].role = null;
  }
  else if (type === 'ping') {
    ws.send(JSON.stringify({type: 'pong'}));
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', function(err) {
  console.log('[SERVER] Uncaught exception:', err.message);
});

server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
