"""
JS query strings used by the civretro CDP client.

All constants here are verbatim JS expressions passed to Runtime.evaluate.
No Python logic — strings only.
"""

READINESS_JS = """(function(){
  try {
    var t = Game.turn;
    var l = GameContext.localPlayerID;
    var p = Players.get(l);
    if (typeof t !== 'number') return 'NOT_READY:turn';
    if (typeof l !== 'number') return 'NOT_READY:localId';
    if (!p) return 'NOT_READY:player';
    if (typeof Autoplay === 'undefined') return 'NOT_READY:Autoplay';
    return 'READY:' + t;
  } catch(e) { return 'NOT_READY:' + e.message; }
})()"""


PLAYER_ROSTER_JS = """(function(){
  try {
    var ids = Players.getAliveMajorIds();
    var roster = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var p = Players.get(id);
      var civResolved = null, leaderResolved = null;
      try { leaderResolved = Locale.compose(p.name); } catch(e) {}
      roster.push({
        id: id, name: p.name, leaderResolved: leaderResolved,
        civType: p.civilizationType, leaderType: p.leaderType,
        isHuman: p.isHuman
      });
    }
    return JSON.stringify({
      roster: roster,
      mapW: GameplayMap.getGridWidth(),
      mapH: GameplayMap.getGridHeight(),
      turn: Game.turn, age: Game.age
    });
  } catch(e) { return JSON.stringify({error: e.message}); }
})()"""
