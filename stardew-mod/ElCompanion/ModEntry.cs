using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace ElCompanion
{
    public class ModEntry : Mod
    {
        private HttpListener? _listener;
        private readonly ConcurrentQueue<Action> _gameQueue = new();

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            StartHttp();
            Monitor.Log("El Companion loaded — HTTP on http://localhost:7421/", LogLevel.Info);
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            while (_gameQueue.TryDequeue(out var act))
            {
                try { act(); }
                catch (Exception ex) { Monitor.Log($"game action error: {ex.Message}", LogLevel.Error); }
            }
        }

        private void StartHttp()
        {
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://localhost:7421/");
            try { _listener.Start(); }
            catch (Exception ex)
            {
                Monitor.Log($"无法启动 HTTP 服务：{ex.Message}", LogLevel.Error);
                return;
            }
            new Thread(ListenLoop) { IsBackground = true, Name = "ElCompanionHttp" }.Start();
        }

        private void ListenLoop()
        {
            while (_listener?.IsListening == true)
            {
                try
                {
                    var ctx = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
                }
                catch { }
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            res.ContentType = "application/json; charset=utf-8";
            res.Headers.Add("Access-Control-Allow-Origin", "*");

            string body;
            try
            {
                var path = req.Url?.AbsolutePath ?? "/";
                if (req.HttpMethod == "GET" && path == "/health")
                    body = Json(new { ok = true, inGame = Context.IsWorldReady });
                else if (req.HttpMethod == "GET" && path == "/state")
                    body = GetState();
                else if (req.HttpMethod == "POST" && path == "/action")
                {
                    using var sr = new System.IO.StreamReader(req.InputStream, Encoding.UTF8);
                    body = DoAction(sr.ReadToEnd());
                }
                else
                {
                    res.StatusCode = 404;
                    body = Json(new { error = "not found" });
                }
            }
            catch (Exception ex)
            {
                res.StatusCode = 500;
                body = Json(new { error = ex.Message });
            }

            var bytes = Encoding.UTF8.GetBytes(body);
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.OutputStream.Close();
        }

        private string GetState()
        {
            if (!Context.IsWorldReady)
                return Json(new { inGame = false, error = "请先进入存档" });

            var player = Game1.player;
            var loc = player.currentLocation;

            var needWater = new List<object>();
            var readyHarvest = new List<object>();
            int totalTiles = 0;

            if (loc != null)
            {
                foreach (var pair in loc.terrainFeatures.Pairs)
                {
                    if (pair.Value is HoeDirt dirt)
                    {
                        totalTiles++;
                        bool watered = dirt.state.Value == HoeDirt.watered;
                        var crop = dirt.crop;
                        if (crop != null)
                        {
                            if (!watered)
                                needWater.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                            if (IsCropReady(crop))
                                readyHarvest.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                        }
                        else if (!watered)
                        {
                            needWater.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                        }
                    }
                }
            }

            var inv = new List<object>();
            foreach (var item in player.Items)
                if (item != null) inv.Add(new { name = item.Name, stack = item.Stack });

            return Json(new
            {
                inGame = true,
                season = Game1.currentSeason,
                day = Game1.dayOfMonth,
                year = Game1.year,
                time = Game1.timeOfDay,
                weather = Game1.isRaining ? "rain" : Game1.isLightning ? "storm" : Game1.isSnowing ? "snow" : "sunny",
                playerName = player.Name,
                energy = (int)player.Stamina,
                maxEnergy = player.MaxStamina,
                money = player.Money,
                location = loc?.Name ?? "unknown",
                totalCropTiles = totalTiles,
                needWaterCount = needWater.Count,
                readyHarvestCount = readyHarvest.Count,
                needWaterList = needWater,
                readyHarvestList = readyHarvest,
                inventory = inv,
            });
        }

        private static bool IsCropReady(Crop crop)
        {
            if (crop.dead.Value) return false;
            // regrowable crops use fullyGrown
            if (crop.fullyGrown.Value) return true;
            // normal crops: last phase reached
            return crop.currentPhase.Value >= crop.phaseDays.Count - 1;
        }

        private string DoAction(string reqBody)
        {
            if (!Context.IsWorldReady)
                return Json(new { ok = false, error = "游戏未进入存档" });

            JsonElement root;
            try { root = JsonDocument.Parse(reqBody).RootElement; }
            catch { return Json(new { ok = false, error = "JSON 解析失败" }); }

            var action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "" : "";
            var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";

            var tcs = new TaskCompletionSource<string>();

            _gameQueue.Enqueue(() =>
            {
                try
                {
                    var result = RunGameAction(action, text);
                    tcs.TrySetResult(Json(new { ok = true, action, result }));
                }
                catch (Exception ex)
                {
                    tcs.TrySetResult(Json(new { ok = false, action, error = ex.Message }));
                }
            });

            return tcs.Task.Wait(5000) ? tcs.Task.Result : Json(new { ok = false, error = "游戏线程超时" });
        }

        private string RunGameAction(string action, string text)
        {
            var player = Game1.player;
            var loc = player.currentLocation;

            switch (action)
            {
                case "say":
                    Game1.addHUDMessage(new HUDMessage($"El: {text}", HUDMessage.newQuest_type));
                    return $"说了：{text}";

                case "notify":
                    Game1.addHUDMessage(new HUDMessage(text, HUDMessage.achievement_type));
                    return "通知已显示";

                case "water_all":
                    return WaterAll(loc);

                case "harvest_all":
                    return HarvestAll(loc, player);

                case "get_state":
                    return GetState();

                default:
                    return $"未知 action: {action}";
            }
        }

        private string WaterAll(GameLocation loc)
        {
            if (loc == null) return "当前没有地图";
            int count = 0;
            foreach (var pair in loc.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt dirt && dirt.state.Value != HoeDirt.watered)
                {
                    dirt.state.Value = HoeDirt.watered;
                    count++;
                }
            }
            Game1.addHUDMessage(new HUDMessage($"El 浇了 {count} 块地", HUDMessage.newQuest_type));
            return $"浇水完成，共 {count} 块";
        }

        private string HarvestAll(GameLocation loc, Farmer player)
        {
            if (loc == null) return "当前没有地图";
            int count = 0;
            var toDestroy = new List<Vector2>();

            foreach (var pair in loc.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt dirt && dirt.crop != null && IsCropReady(dirt.crop))
                {
                    if (dirt.crop.harvest((int)pair.Key.X, (int)pair.Key.Y, dirt))
                    {
                        toDestroy.Add(pair.Key);
                        count++;
                    }
                }
            }

            foreach (var v in toDestroy)
            {
                if (loc.terrainFeatures.TryGetValue(v, out var f) && f is HoeDirt d)
                    d.crop = null;
            }

            Game1.addHUDMessage(new HUDMessage($"El 收割了 {count} 个作物", HUDMessage.newQuest_type));
            return $"收割完成，共 {count} 个";
        }

        private static string Json(object obj) =>
            JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = false });
    }
}
