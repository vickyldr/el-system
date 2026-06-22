using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;

namespace ElCompanion
{
    internal class BotTask
    {
        public Vector2 TilePos;   // tile coords (not pixels)
        public string Action;     // "water" or "harvest"
    }

    internal class BotFarmer
    {
        public Farmer Farmer { get; private set; }

        private readonly IMonitor _monitor;
        private readonly Queue<BotTask> _queue = new();
        private BotTask _current;

        private enum State { Idle, Moving, Acting }
        private State _state = State.Idle;

        private Vector2 _targetPixel;   // pixel destination
        private Vector2 _homePixel;
        private int _actTimer;
        private int _walkFrame;
        private int _walkTick;

        private const float Speed = 3f;
        private const int ActDuration = 50; // ticks to play action anim

        public BotFarmer(IMonitor monitor) => _monitor = monitor;

        public void Init()
        {
            Farmer = new Farmer();
            Farmer.Name = "El";
            Farmer.UniqueMultiplayerID = -9999L;

            var farm = Game1.getFarm();
            Farmer.currentLocation = farm;

            // Start position: near farmhouse (tile 64,14)
            _homePixel = new Vector2(64 * 64f, 14 * 64f);
            Farmer.Position = _homePixel;
            Farmer.FacingDirection = 2; // facing down

            // Give her an iridium watering can (for the animation frame)
            var can = new WateringCan { UpgradeLevel = 4 };
            Farmer.addItemToInventory(can);

            _monitor.Log("El bot farmer 已创建，位置 tile(64,14)", LogLevel.Debug);
        }

        // ── Public API called from HTTP handler ──────────────────────

        public void EnqueueWaterAll()
        {
            var farm = Game1.getFarm();
            foreach (var pair in farm.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt d && d.crop != null && d.state.Value != HoeDirt.watered)
                    _queue.Enqueue(new BotTask { TilePos = pair.Key, Action = "water" });
            }
            TryStart();
        }

        public void EnqueueHarvestAll()
        {
            var farm = Game1.getFarm();
            foreach (var pair in farm.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt d && d.crop != null && IsCropReady(d.crop))
                    _queue.Enqueue(new BotTask { TilePos = pair.Key, Action = "harvest" });
            }
            TryStart();
        }

        private static bool IsCropReady(Crop c) =>
            !c.dead.Value && (c.fullyGrown.Value || c.currentPhase.Value >= c.phaseDays.Count - 1);

        // ── Per-tick update ──────────────────────────────────────────

        public void Update()
        {
            if (Farmer == null || !Context.IsWorldReady) return;

            switch (_state)
            {
                case State.Idle:
                    break;
                case State.Moving:
                    DoMove();
                    break;
                case State.Acting:
                    DoAct();
                    break;
            }
        }

        private void TryStart()
        {
            if (_state == State.Idle && _queue.Count > 0)
                AdvanceQueue();
        }

        private void AdvanceQueue()
        {
            if (_queue.Count == 0)
            {
                // Return home
                _targetPixel = _homePixel;
                _current = null;
                _state = State.Moving;
                return;
            }
            _current = _queue.Dequeue();
            _targetPixel = _current.TilePos * 64f;
            _state = State.Moving;
        }

        private void DoMove()
        {
            var pos = Farmer.Position;
            var diff = _targetPixel - pos;
            float dist = diff.Length();

            if (dist < Speed + 1f)
            {
                Farmer.Position = _targetPixel;
                if (_current != null)
                {
                    // Arrived at task tile
                    FaceTowardCenter();
                    _state = State.Acting;
                    _actTimer = ActDuration;
                    SetToolFrame();
                }
                else
                {
                    // Arrived home
                    Farmer.FacingDirection = 2;
                    SetIdleFrame();
                    _state = State.Idle;
                }
                return;
            }

            Vector2 step = Vector2.Normalize(diff) * Speed;
            Farmer.Position = pos + step;

            // Facing direction
            if (Math.Abs(diff.X) >= Math.Abs(diff.Y))
                Farmer.FacingDirection = diff.X > 0 ? 1 : 3;
            else
                Farmer.FacingDirection = diff.Y > 0 ? 2 : 0;

            // Walk animation (4-frame cycle, advance every 8 ticks)
            _walkTick++;
            if (_walkTick >= 8) { _walkTick = 0; _walkFrame = (_walkFrame + 1) % 4; }
            SetWalkFrame();
        }

        private void DoAct()
        {
            _actTimer--;
            if (_actTimer > 0) return;

            // Execute the actual game action
            ExecuteCurrentTask();
            AdvanceQueue();
        }

        private void ExecuteCurrentTask()
        {
            if (_current == null) return;
            var farm = Game1.getFarm();
            if (!farm.terrainFeatures.TryGetValue(_current.TilePos, out var feat) || feat is not HoeDirt dirt) return;

            if (_current.Action == "water")
            {
                dirt.state.Value = HoeDirt.watered;
            }
            else if (_current.Action == "harvest" && dirt.crop != null)
            {
                dirt.crop.harvest((int)_current.TilePos.X, (int)_current.TilePos.Y, dirt);
                dirt.crop = null;
            }
        }

        // ── Sprite helpers ───────────────────────────────────────────

        // SDV farmer sprite rows: down=0, right=1, up=2, left=3 (each row has cols 0..7 in the sheet, but standard walk is 0-3)
        private int FacingToRow() => Farmer.FacingDirection switch
        {
            0 => 2, // up
            1 => 1, // right
            3 => 3, // left
            _ => 0  // down
        };

        private void SetWalkFrame()
        {
            int row = FacingToRow();
            Farmer.Sprite.currentFrame = row * 16 + _walkFrame;
        }

        private void SetIdleFrame()
        {
            int row = FacingToRow();
            Farmer.Sprite.currentFrame = row * 16;
        }

        private void SetToolFrame()
        {
            // Watering can use frame area (rough estimate; SDV uses row 8-9 region)
            Farmer.Sprite.currentFrame = FacingToRow() * 16 + 58 % 16;
        }

        private void FaceTowardCenter()
        {
            // Face toward the farm center roughly
            var pos = Farmer.Position;
            var center = new Vector2(40 * 64f, 40 * 64f);
            var diff = center - pos;
            if (Math.Abs(diff.X) >= Math.Abs(diff.Y))
                Farmer.FacingDirection = diff.X > 0 ? 1 : 3;
            else
                Farmer.FacingDirection = diff.Y > 0 ? 2 : 0;
        }
    }
}
