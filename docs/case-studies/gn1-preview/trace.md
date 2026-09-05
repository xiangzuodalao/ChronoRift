# GN-1 Preview：真实调用摘录

这是 **已保存会话的整理视图**，不是完整原始 Session，也不是重新运行模型。机器可读记录见 [trace.json](trace.json)，来源与脱敏规则见 [provenance.json](provenance.json)。全部 20 个 game 操作、实际 edit 与调查异常均保留。

## 如何核对

- 表中的行号指原始 `pi-session.jsonl`；同一 assistant 消息中的并发请求可共享行号。调用编号按原始全部 43 个请求排序，因此有缺号。
- `inspection.before` / `inspection.after` 是两个原始 execution ID 的一对一替换；`.object.N` 保持原值。不同 execution、独立检查进程之间的引用不可比较。
- `trace.json` 的 game 输出是实际文本解析后的 JSON，与原始 tool details 相同；coding 输出保留原文和截断字段。没有重写失败输出或补写调用。
- 修改前 Agent **只查询了 Platform3 的一个 Area Shape**。四个 baseline Shape 共享的直接检查来自会话结束后的独立检查，不属于 Agent 当时获得的信息。
- 删除 thinking、provider/message/signature ID 和无关 coding 输出；Host 路径使用声明的占位符。Godot 的 `/root/Global` 与 `res://` 是场景/资源路径，不是 Host 私有路径。

## 调用索引

原始 43 个请求、42 个结果；本摘录 34 个请求、33 个结果。未选取的 9 个 coding 调用列在 JSON 的 `omittedCalls`。

| 调用    | 原始请求 / 结果行 | 工具        | 实际返回摘要（编辑性摘要，原文在 JSON）                                                                                                                                                                                                        |
| ------- | ----------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| call.1  | 5 / 6             | ls          | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.2  | 5 / 7             | find        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.3  | 8 / 9             | read        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.4  | 8 / 10            | read        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.5  | 8 / 11            | read        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.8  | 8 / 14            | read        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.16 | 25 / 26           | game_launch | success; inspection.before; res://main.tscn                                                                                                                                                                                                    |
| call.17 | 27 / 28           | game_query  | 4 个子节点；Platform, Platform2, Platform3, Platform4                                                                                                                                                                                          |
| call.18 | 29 / 30           | game_query  | width=2; fall_time=-1; position={"$type":"vector2","x":-113,"y":23}                                                                                                                                                                            |
| call.19 | 29 / 31           | game_query  | width=1; fall_time=-1; position={"$type":"vector2","x":-283,"y":24}                                                                                                                                                                            |
| call.20 | 29 / 32           | game_query  | width=3; fall_time=2; position={"$type":"vector2","x":-549,"y":-82}                                                                                                                                                                            |
| call.21 | 29 / 33           | game_query  | width=6; fall_time=-1; position={"$type":"vector2","x":-570,"y":16}                                                                                                                                                                            |
| call.22 | 34 / 35           | game_query  | 2 个子节点；RigidBody2D, @Timer@11                                                                                                                                                                                                             |
| call.23 | 36 / 37           | game_query  | shape={"$type":"object","className":"RectangleShape2D","objectRef":"inspection.before.object.10","resourcePath":"res://components/platform/platform.tscn::RectangleShape2D_i4vtk"}; position={"$type":"vector2","x":0,"y":-84}; disabled=false |
| call.24 | 38 / 39           | game_query  | size={"$type":"vector2","x":768,"y":40}                                                                                                                                                                                                        |
| call.25 | 40 / 41           | game_stop   | success; child exitCode=null / SIGTERM，sidecar exitCode=0                                                                                                                                                                                     |
| call.26 | 42 / 43           | edit        | Successfully replaced 1 block(s) in components/platform/platform.gd.                                                                                                                                                                           |
| call.27 | 44 / 45           | bash        | [Command failed; exitCode=128]                                                                                                                                                                                                                 |
| call.28 | 44 / 46           | read        | 源码/列表原文见 trace.json                                                                                                                                                                                                                     |
| call.29 | 47 / 48           | bash        | [Command failed; exitCode=129]                                                                                                                                                                                                                 |
| call.30 | 49 / 50           | bash        | [Command failed; exitCode=128]                                                                                                                                                                                                                 |
| call.31 | 51 / 52           | bash        | [Command failed; exitCode=128]                                                                                                                                                                                                                 |
| call.32 | 53                | bash        | 无执行结果；不能计为已执行                                                                                                                                                                                                                     |
| call.33 | 54 / 55           | bash        | 返回记录见 trace.json；无失败标记                                                                                                                                                                                                              |
| call.34 | 56 / 57           | game_launch | success; inspection.after; res://main.tscn                                                                                                                                                                                                     |
| call.35 | 58 / 59           | game_query  | shape={"$type":"object","className":"RectangleShape2D","objectRef":"inspection.after.object.3","resourcePath":""}                                                                                                                              |
| call.36 | 58 / 60           | game_query  | shape={"$type":"object","className":"RectangleShape2D","objectRef":"inspection.after.object.5","resourcePath":""}                                                                                                                              |
| call.37 | 58 / 61           | game_query  | shape={"$type":"object","className":"RectangleShape2D","objectRef":"inspection.after.object.7","resourcePath":""}                                                                                                                              |
| call.38 | 58 / 62           | game_query  | shape={"$type":"object","className":"RectangleShape2D","objectRef":"inspection.after.object.9","resourcePath":""}                                                                                                                              |
| call.39 | 63 / 64           | game_query  | size={"$type":"vector2","x":256,"y":40}                                                                                                                                                                                                        |
| call.40 | 63 / 65           | game_query  | size={"$type":"vector2","x":128,"y":40}                                                                                                                                                                                                        |
| call.41 | 63 / 66           | game_query  | size={"$type":"vector2","x":384,"y":40}                                                                                                                                                                                                        |
| call.42 | 63 / 67           | game_query  | size={"$type":"vector2","x":768,"y":40}                                                                                                                                                                                                        |
| call.43 | 68 / 69           | game_stop   | success; child exitCode=null / SIGTERM，sidecar exitCode=0                                                                                                                                                                                     |

## 修改前：从节点到 Shape

先读取平台脚本、场景和主场景（第 8–14 行），再查询 Platforms 子节点（27–28）、平台属性（29–33）及 Platform3 子节点（34–35）。平台脚本给出 TILE_WIDTH=128；Platform3 的实际 width=3（第 32 行）。下面是原始调用和返回，仅替换 execution ID：

```json
{
  "sourceLines": [36, 37],
  "toolName": "game_query",
  "input": {
    "schemaVersion": 1,
    "executionId": "inspection.before",
    "target": {
      "path": "Platforms/Platform3/RigidBody2D/Area2D/AreaCollisionShape2D"
    },
    "select": "values",
    "names": ["shape", "position", "disabled"]
  },
  "output": {
    "schemaVersion": 1,
    "outcome": "success",
    "output": {
      "schemaVersion": 1,
      "executionId": "inspection.before",
      "sample": {
        "processFrame": 3117,
        "physicsTick": 1299
      },
      "target": {
        "objectRef": "inspection.before.object.9",
        "className": "CollisionShape2D",
        "name": "AreaCollisionShape2D",
        "path": "Platforms/Platform3/RigidBody2D/Area2D/AreaCollisionShape2D",
        "childCount": 0
      },
      "select": "values",
      "values": [
        {
          "name": "shape",
          "status": "success",
          "value": {
            "$type": "object",
            "className": "RectangleShape2D",
            "objectRef": "inspection.before.object.10",
            "resourcePath": "res://components/platform/platform.tscn::RectangleShape2D_i4vtk"
          }
        },
        {
          "name": "position",
          "status": "success",
          "value": {
            "$type": "vector2",
            "x": 0,
            "y": -84
          }
        },
        {
          "name": "disabled",
          "status": "success",
          "value": false
        }
      ],
      "hostReceivedAt": "2026-09-05T12:52:24.582Z"
    }
  }
}
```

```json
{
  "sourceLines": [38, 39],
  "toolName": "game_query",
  "input": {
    "schemaVersion": 1,
    "executionId": "inspection.before",
    "target": {
      "objectRef": "inspection.before.object.10"
    },
    "select": "values",
    "names": ["size"]
  },
  "output": {
    "schemaVersion": 1,
    "outcome": "success",
    "output": {
      "schemaVersion": 1,
      "executionId": "inspection.before",
      "sample": {
        "processFrame": 3935,
        "physicsTick": 1638
      },
      "target": {
        "objectRef": "inspection.before.object.10",
        "className": "RectangleShape2D",
        "resourcePath": "res://components/platform/platform.tscn::RectangleShape2D_i4vtk"
      },
      "select": "values",
      "values": [
        {
          "name": "size",
          "status": "success",
          "value": {
            "$type": "vector2",
            "x": 768,
            "y": 40
          }
        }
      ],
      "hostReceivedAt": "2026-09-05T12:52:30.225Z"
    }
  }
}
```

这里直接观察到的是该实例 Area 为 768×40，而期望宽度为 3×128=384；“共享资源”是结合源码作出的解释，不是修改前的四实例 identity 观察。

## 修改与重新启动

停止第一次执行（40–41）后，Agent 的实际 edit 是：

```json
{
  "sourceLines": [42, 43],
  "toolName": "edit",
  "input": {
    "path": "components/platform/platform.gd",
    "edits": [
      {
        "oldText": "\t_area_collision_shape.shape.set_size(\n\t\tVector2(width * TILE_WIDTH, _area_collision_shape.shape.size[1])\n\t)",
        "newText": "\t_area_collision_shape.shape = _area_collision_shape.shape.duplicate()\n\t_area_collision_shape.shape.set_size(\n\t\tVector2(width * TILE_WIDTH, _area_collision_shape.shape.size[1])\n\t)"
      }
    ]
  },
  "output": {
    "content": [
      {
        "type": "text",
        "text": "Successfully replaced 1 block(s) in components/platform/platform.gd."
      }
    ],
    "details": {
      "diff": "     ...\n  46 \n  47 \t_collision_shape.shape = RectangleShape2D.new()\n  48 \t_collision_shape.one_way_collision = one_way\n  49 \t_collision_shape.shape.set_size(Vector2(width * TILE_WIDTH, TILE_WIDTH))\n+ 50 \t_area_collision_shape.shape = _area_collision_shape.shape.duplicate()\n  50 \t_area_collision_shape.shape.set_size(\n  51 \t\tVector2(width * TILE_WIDTH, _area_collision_shape.shape.size[1])\n  52 \t)\n  53 \n     ...",
      "patch": "--- components/platform/platform.gd\n+++ components/platform/platform.gd\n@@ -46,8 +46,9 @@\n \n \t_collision_shape.shape = RectangleShape2D.new()\n \t_collision_shape.one_way_collision = one_way\n \t_collision_shape.shape.set_size(Vector2(width * TILE_WIDTH, TILE_WIDTH))\n+\t_area_collision_shape.shape = _area_collision_shape.shape.duplicate()\n \t_area_collision_shape.shape.set_size(\n \t\tVector2(width * TILE_WIDTH, _area_collision_shape.shape.size[1])\n \t)\n \n",
      "firstChangedLine": 50
    }
  }
}
```

实际 patch 另存于 [candidate.patch](candidate.patch)，由 Host 提取并在当时通过 round-trip 校验，不是把 Agent 的 diff 展示重新拼成补丁。修改后重新 launch（56–57），查询四个 Area Shape（58–62）并分别查询 size（63–67）：

| 平台      | 新 execution 中的 Shape 引用 | 实际 size | Shape / size 结果行 |
| --------- | ---------------------------- | --------- | ------------------- |
| Platform  | inspection.after.object.3    | 256×40    | 59 / 64             |
| Platform2 | inspection.after.object.5    | 128×40    | 60 / 65             |
| Platform3 | inspection.after.object.7    | 384×40    | 61 / 66             |
| Platform4 | inspection.after.object.9    | 768×40    | 62 / 67             |

这些是不同 process frame / physics tick 的现场读取，不是原子快照或历史回放。两次显式 stop 后，Godot child 均为 `exitCode=null, signal=SIGTERM`；sidecar 的 `exitCode=0` 不等于 Godot 自然退出成功。见 [before](runtime-records/before.json) / [after](runtime-records/after.json)。

## 不能省掉的异常

- 第 45、50、52 行：Git external diff 失败，实际 exitCode=128。第 48 行：`--no-ext-diff` 参数位置错误，exitCode=129。工具消息的 `isError=false` 没有掩盖正文中的命令失败标记。
- 第 53 行：持久化 assistant 消息记录 `WebSocket error`，其中的 bash 请求没有结果；不能当作已执行。第 54–55 行的另一次 bash 请求有真实结果，随后会话继续。内部网络重试次数未完整暴露。
- 没有为发布回头修环境、补演更顺畅的调查，或隐藏上述失败。

## Agent 最终文字不是验收

第 70 行的最终文字保存在 JSON，`acceptanceEvidence=false`。它只是 Agent 的交付说明。CLI 的 `completed` 只表示 Loop 完成。

独立检查在 CLI 结束之后运行，原始 stdout 见 [baseline](independent/baseline/stdout.log) / [candidate](independent/candidate/stdout.log)。它检查四个平台的初始几何和资源身份：baseline exit 1（3 个尺寸问题、6 对共享引用），candidate exit 0。它没有验证完整玩家触发或下落时序，也未把结果返回这次 Agent 会话。
