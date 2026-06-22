using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Characters;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace ElCompanion
{
    public class ModEntry : Mod
    {
        internal static BotFarmer? Bot;

        private HttpListener? _listener;
        private readonly ConcurrentQueue<Action> _gameQueue = new();

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.SaveLoaded += OnSaveLoaded;
            helper.Events.GameLoop.ReturnedToTitle += OnReturnedToTitle;
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.Display.RenderedWorld += OnRenderedWorld;
            helper.Events.Input.ButtonPressed += OnButtonPressed;
            StartHttp();
            Monitor.Log("El Companion loaded — HTTP on http://localhost:7421/", LogLevel.Info);
        }

        private void OnButtonPressed(object? sender, StardewModdingAPI.Events.ButtonPressedEventArgs e)
        {
            if (!Context.IsWorldReady || Bot?.Farmer == null) return;
            if (e.Button != SButton.MouseLeft && e.Button != SButton.ControllerA) return;
            if (Bot.Farmer.currentLocation != Game1.currentLocation) return;

            // Check if player clicked near El
            var elScreen = Game1.GlobalToLocal(Game1.viewport, Bot.Farmer.Position);
            var clickPos = new Vector2(Game1.getMouseX(), Game1.getMouseY());
            if (Vector2.Distance(elScreen, clickPos) < 64f)
            {
                Game1.activeClickableMenu = new DialogueMenu(msg =>
                {
                    // Post message to bridge
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            var bridgeUrl = System.Environment.GetEnvironmentVariable("BRIDGE_URL") ?? "https://el-system-production.up.railway.app";
                            var secret = System.Environment.GetEnvironmentVariable("BRIDGE_SECRET") ?? "";
                            using var client = new System.Net.Http.HttpClient();
                            if (!string.IsNullOrEmpty(secret))
                                client.DefaultRequestHeaders.Add("x-bridge-secret", secret);
                            var payload = System.Text.Json.JsonSerializer.Serialize(new { message = msg, from = "player_ingame" });
                            await client.PostAsync($"{bridgeUrl}/stardew-inbox",
                                new System.Net.Http.StringContent(payload, System.Text.Encoding.UTF8, "application/json"));
                            // Show confirmation in-game
                            _gameQueue.Enqueue(() =>
                                Game1.addHUDMessage(new HUDMessage($"El 收到了：{msg}", HUDMessage.newQuest_type)));
                        }
                        catch { }
                    });
                });
                Helper.Input.Suppress(e.Button);
            }
        }

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            Bot = new BotFarmer(Monitor);
            Bot.Init();
        }

        private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
        {
            Bot = null;
        }

        private void OnRenderedWorld(object? sender, StardewModdingAPI.Events.RenderedWorldEventArgs e)
        {
            var bot = Bot;
            if (bot?.Farmer == null) return;
            if (bot.Farmer.currentLocation != Game1.currentLocation) return;
            // Debug: pink box at El's position
            var screenPos = Game1.GlobalToLocal(Game1.viewport, bot.Farmer.Position);
            e.SpriteBatch.Draw(Game1.staminaRect, new Microsoft.Xna.Framework.Rectangle((int)screenPos.X, (int)screenPos.Y, 32, 64), Color.HotPink * 0.8f);
            bot.Farmer.draw(e.SpriteBatch, 1f);
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            while (_gameQueue.TryDequeue(out var act))
            {
                try { act(); }
                catch (Exception ex) { Monitor.Log($"game action error: {ex.Message}", LogLevel.Error); }
            }

            Bot?.Update();
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
                else if (req.HttpMethod == "POST" && path == "/inbox-response")
                {
                    using var sr2 = new System.IO.StreamReader(req.InputStream, Encoding.UTF8);
                    var rawBody = sr2.ReadToEnd();
                    var doc2 = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(rawBody);
                    string resp = doc2.TryGetProperty("text", out var rt) ? rt.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(resp))
                    {
                        _gameQueue.Enqueue(() => Game1.drawObjectDialogue(resp));
                    }
                    body = Json(new { ok = true });
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
            var farm = Game1.getFarm();
            var loc = player.currentLocation;

            // ── 农田作物 ──
            var needWater = new List<object>();
            var readyHarvest = new List<object>();
            var cropDetails = new List<object>();
            int totalTiles = 0;

            if (farm != null)
            {
                foreach (var pair in farm.terrainFeatures.Pairs)
                {
                    if (pair.Value is HoeDirt dirt)
                    {
                        totalTiles++;
                        bool watered = dirt.state.Value == HoeDirt.watered;
                        var crop = dirt.crop;
                        if (crop != null)
                        {
                            if (!watered) needWater.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                            bool ready = IsCropReady(crop);
                            if (ready) readyHarvest.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                            int daysLeft = ready ? 0 : Math.Max(0,
                                crop.phaseDays.Count > 0
                                    ? crop.phaseDays.Skip(crop.currentPhase.Value).Sum() - crop.dayOfCurrentPhase.Value
                                    : 0);
                            cropDetails.Add(new
                            {
                                x = (int)pair.Key.X, y = (int)pair.Key.Y,
                                watered,
                                ready,
                                daysLeft,
                                dead = crop.dead.Value,
                            });
                        }
                        else if (!watered)
                        {
                            needWater.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y });
                        }
                    }
                }
            }

            // ── 动物 ──
            var animals = new List<object>();
            if (farm != null)
            {
                foreach (var building in farm.buildings)
                {
                    if (building.indoors.Value is AnimalHouse house)
                    {
                        foreach (var animal in house.animals.Values)
                        {
                            animals.Add(new
                            {
                                name = animal.Name,
                                type = animal.type.Value,
                                happiness = animal.happiness.Value,
                                friendship = animal.friendshipTowardFarmer.Value,
                                wasPet = animal.wasPet.Value,
                                age = animal.age.Value,
                                produceDaysLeft = animal.daysSinceLastLay.Value,
                            });
                        }
                    }
                }
            }

            // ── 加工机器 ──
            var machines = new List<object>();
            if (farm != null)
            {
                foreach (var obj in farm.objects.Values)
                {
                    if (obj is Cask or CrabPot || obj.bigCraftable.Value)
                    {
                        if (obj.heldObject.Value != null)
                        {
                            machines.Add(new
                            {
                                name = obj.Name,
                                producing = obj.heldObject.Value.Name,
                                readyForPickup = obj.readyForHarvest.Value,
                                minutesLeft = obj.MinutesUntilReady,
                            });
                        }
                    }
                }
            }

            // ── 今日任务/委托 ──
            var quests = new List<object>();
            foreach (var q in player.questLog)
            {
                quests.Add(new { title = q.GetName(), description = q.GetDescription(), completed = q.completed.Value });
            }

            // ── NPC 今日生日 ──
            var birthdays = new List<string>();
            foreach (var npc in Utility.getAllCharacters())
            {
                if (npc.Birthday_Season == Game1.currentSeason && npc.Birthday_Day == Game1.dayOfMonth)
                    birthdays.Add(npc.Name);
            }

            // ── NPC 好感度 ──
            var friendships = new List<object>();
            foreach (var f in player.friendshipData.Pairs)
            {
                friendships.Add(new { name = f.Key, hearts = f.Value.Points / NPC.friendshipPointsPerHeartLevel, points = f.Value.Points, talked = f.Value.TalkedToToday });
            }

            // ── 背包 ──
            var inv = new List<object>();
            foreach (var item in player.Items)
                if (item != null) inv.Add(new { name = item.Name, stack = item.Stack, category = item.getCategoryName() });

            // ── 技能等级 ──
            var skills = new
            {
                farming = player.FarmingLevel,
                mining = player.MiningLevel,
                foraging = player.ForagingLevel,
                fishing = player.FishingLevel,
                combat = player.CombatLevel,
                luck = player.LuckLevel,
            };

            // ── 明天天气 ──
            string tomorrowWeather = Game1.weatherForTomorrow switch
            {
                Game1.weather_rain => "rain",
                Game1.weather_lightning => "storm",
                Game1.weather_snow => "snow",
                Game1.weather_festival => "festival",
                _ => "sunny",
            };

            return Json(new
            {
                inGame = true,
                season = Game1.currentSeason,
                day = Game1.dayOfMonth,
                year = Game1.year,
                time = Game1.timeOfDay,
                weather = Game1.isRaining ? "rain" : Game1.isLightning ? "storm" : Game1.isSnowing ? "snow" : "sunny",
                tomorrowWeather,
                playerName = player.Name,
                energy = (int)player.Stamina,
                maxEnergy = player.MaxStamina,
                money = player.Money,
                location = loc?.Name ?? "unknown",
                skills,
                totalCropTiles = totalTiles,
                needWaterCount = needWater.Count,
                readyHarvestCount = readyHarvest.Count,
                cropDetails,
                animals,
                machines,
                quests,
                birthdays,
                friendships,
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
            try { root = JsonDocument.Parse(reqBody).RootElement.Clone(); }
            catch { return Json(new { ok = false, error = "JSON 解析失败" }); }

            var action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "" : "";
            var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";

            var tcs = new TaskCompletionSource<string>();
            var rootCopy = root;

            _gameQueue.Enqueue(() =>
            {
                try
                {
                    var result = RunGameAction(action, text, rootCopy);
                    tcs.TrySetResult(Json(new { ok = true, action, result }));
                }
                catch (Exception ex)
                {
                    tcs.TrySetResult(Json(new { ok = false, action, error = ex.Message }));
                }
            });

            return tcs.Task.Wait(5000) ? tcs.Task.Result : Json(new { ok = false, error = "游戏线程超时" });
        }

        private string RunGameAction(string action, string text, JsonElement root)
        {
            var player = Game1.player;

            switch (action)
            {
                case "say":
                    Game1.addHUDMessage(new HUDMessage($"El: {text}", HUDMessage.newQuest_type));
                    return $"说了：{text}";

                case "notify":
                    Game1.addHUDMessage(new HUDMessage(text, HUDMessage.achievement_type));
                    return "通知已显示";

                case "water_all":
                    Bot?.EnqueueWaterAll();
                    return Json(new { ok = true, msg = "El 开始浇水，请稍候…" });

                case "harvest_all":
                    Bot?.EnqueueHarvestAll();
                    return Json(new { ok = true, msg = "El 开始收割，请稍候…" });

                case "get_state":
                    return GetState();

                case "say_dialogue":
                    // Shows dialogue box above El's head (different from HUD message)
                    string dlgText = root.TryGetProperty("text", out var dt) ? dt.GetString() ?? "" : text;
                    Game1.drawObjectDialogue(dlgText);
                    return Json(new { ok = true });

                case "go_fish":
                    return BotActions.GoFish(root);

                case "mine":
                    return BotActions.Mine(root);

                case "forage":
                    return BotActions.Forage(root);

                case "sleep":
                    Game1.NewDay(0.0f);
                    return Json(new { ok = true, msg = "晚安~" });

                case "ship":
                    return BotActions.ShipItem(root);

                case "pet_animals":
                    return BotActions.PetAllAnimals();

                case "collect_products":
                    return BotActions.CollectAnimalProducts();

                case "give_gift":
                    return BotActions.GiveGift(root);

                case "warp":
                    string warpDest = root.TryGetProperty("location", out var wd) ? wd.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(warpDest))
                        Game1.warpFarmer(warpDest, 0, 0, false);
                    return Json(new { ok = true });

                default:
                    return $"未知 action: {action}";
            }
        }

        private static string Json(object obj) =>
            JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = false });
    }

}
