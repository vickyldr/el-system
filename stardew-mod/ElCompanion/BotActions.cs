using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Locations;
using StardewValley.Objects;

namespace ElCompanion
{
    internal static class BotActions
    {
        // ── Fishing ──────────────────────────────────────────────────
        // El fishes off-screen; we directly generate fish based on season/location/luck
        public static string GoFish(JsonElement doc)
        {
            string location = doc.TryGetProperty("location", out var lv) ? lv.GetString() ?? "river" : "river";
            int minutes = doc.TryGetProperty("minutes", out var mv) ? mv.GetInt32() : 60;

            // Fish count scales with time and fishing skill
            int fishingLevel = Game1.player.FishingLevel;
            int catchCount = Math.Max(1, (minutes / 15) + (fishingLevel / 3));

            var caught = new List<string>();
            var rng = new Random();

            // Simple season-based fish tables
            var fishPool = GetFishPool(location, Game1.currentSeason);
            for (int i = 0; i < catchCount; i++)
            {
                string fishId = fishPool[rng.Next(fishPool.Length)];
                var fish = ItemRegistry.Create(fishId);
                Game1.player.addItemToInventory(fish);
                caught.Add(fish.DisplayName);
            }

            return JsonSerializer.Serialize(new
            {
                ok = true,
                msg = $"El 在{LocationName(location)}钓了 {catchCount} 条鱼",
                caught
            });
        }

        private static string LocationName(string loc) => loc switch
        {
            "beach" => "海边",
            "mountain_lake" => "山顶湖",
            "forest" => "森林河",
            _ => "河边"
        };

        private static string[] GetFishPool(string location, string season) => location switch
        {
            "beach" => season switch
            {
                "spring" => new[] { "(o)131", "(o)130", "(o)701", "(o)142" },
                "summer" => new[] { "(o)128", "(o)701", "(o)130", "(o)150" },
                "fall"   => new[] { "(o)164", "(o)131", "(o)701", "(o)130" },
                _        => new[] { "(o)130", "(o)701", "(o)131" }
            },
            "mountain_lake" => season switch
            {
                "spring" => new[] { "(o)136", "(o)142", "(o)700", "(o)163" },
                "summer" => new[] { "(o)136", "(o)700", "(o)698", "(o)142" },
                "fall"   => new[] { "(o)699", "(o)136", "(o)700", "(o)163" },
                _        => new[] { "(o)136", "(o)699", "(o)700" }
            },
            _ => season switch  // river
            {
                "spring" => new[] { "(o)145", "(o)137", "(o)142", "(o)700", "(o)706" },
                "summer" => new[] { "(o)145", "(o)699", "(o)698", "(o)142" },
                "fall"   => new[] { "(o)699", "(o)145", "(o)137", "(o)700" },
                _        => new[] { "(o)699", "(o)145", "(o)142" }
            }
        };

        // ── Mining ───────────────────────────────────────────────────
        public static string Mine(JsonElement doc)
        {
            int floor = doc.TryGetProperty("floor", out var fv) ? fv.GetInt32() : 40;
            string goal = doc.TryGetProperty("goal", out var gv) ? gv.GetString() ?? "ores" : "ores";
            int miningLevel = Game1.player.MiningLevel;
            var rng = new Random();
            var gained = new List<string>();

            switch (goal)
            {
                case "ores":
                    gained.AddRange(MineOres(floor, miningLevel, rng));
                    break;
                case "chests":
                    gained.AddRange(OpenChests(floor, rng));
                    break;
                case "combat":
                    gained.AddRange(FightMonsters(floor, rng));
                    break;
                case "deep":
                    // Go deeper — mix of everything
                    gained.AddRange(MineOres(floor, miningLevel, rng));
                    gained.AddRange(FightMonsters(floor, rng));
                    break;
            }

            foreach (var itemId in gained.Select(g => g).ToList())
            {
                try
                {
                    var item = ItemRegistry.Create(itemId);
                    Game1.player.addItemToInventory(item);
                }
                catch { }
            }

            return JsonSerializer.Serialize(new
            {
                ok = true,
                msg = $"El 在矿洞 {floor} 层{GoalName(goal)}完成",
                floor, goal,
                itemsGained = gained.Count
            });
        }

        private static string GoalName(string g) => g switch
        {
            "chests" => "开宝箱",
            "combat" => "刷怪",
            "deep" => "深挖",
            _ => "采矿"
        };

        private static List<string> MineOres(int floor, int level, Random rng)
        {
            var items = new List<string>();
            int count = 8 + level + rng.Next(5);
            // Floor determines ore type
            string oreId = floor switch
            {
                < 40  => "(o)378", // Copper
                < 80  => "(o)380", // Iron
                < 120 => "(o)384", // Gold
                _     => "(o)386"  // Iridium
            };
            for (int i = 0; i < count; i++) items.Add(oreId);
            // Add some coal
            for (int i = 0; i < rng.Next(3, 8); i++) items.Add("(o)382");
            // Chance of gems
            if (rng.Next(3) == 0) items.Add(floor > 80 ? "(o)72" : "(o)60");
            return items;
        }

        private static List<string> OpenChests(int floor, Random rng)
        {
            var items = new List<string>();
            // Chest loot table based on floor
            var loot = floor switch
            {
                < 40  => new[] { "(o)378", "(o)378", "(o)380", "(o)287", "(o)766" },
                < 80  => new[] { "(o)380", "(o)380", "(o)384", "(o)749", "(o)768" },
                < 120 => new[] { "(o)384", "(o)384", "(o)386", "(o)749", "(o)441" },
                _     => new[] { "(o)386", "(o)749", "(o)72", "(o)60", "(o)441" }
            };
            int chests = 1 + rng.Next(3);
            for (int i = 0; i < chests; i++)
            {
                int itemsPerChest = 2 + rng.Next(4);
                for (int j = 0; j < itemsPerChest; j++)
                    items.Add(loot[rng.Next(loot.Length)]);
            }
            return items;
        }

        private static List<string> FightMonsters(int floor, Random rng)
        {
            var items = new List<string>();
            // Monster drops based on floor
            string[] drops = floor switch
            {
                < 40  => new[] { "(o)766", "(o)768", "(o)378" },
                < 80  => new[] { "(o)766", "(o)768", "(o)380", "(o)749" },
                < 120 => new[] { "(o)766", "(o)768", "(o)384", "(o)749" },
                _     => new[] { "(o)766", "(o)768", "(o)386", "(o)749", "(o)439" }
            };
            int kills = 5 + rng.Next(10);
            for (int i = 0; i < kills; i++)
                if (rng.Next(2) == 0) items.Add(drops[rng.Next(drops.Length)]);
            return items;
        }

        // ── Foraging ─────────────────────────────────────────────────
        public static string Forage(JsonElement doc)
        {
            string location = doc.TryGetProperty("location", out var lv) ? lv.GetString() ?? "forest" : "forest";
            var rng = new Random();
            var items = GetForageItems(location, Game1.currentSeason);
            int count = 3 + rng.Next(5);
            var gained = new List<string>();
            for (int i = 0; i < count; i++)
            {
                string id = items[rng.Next(items.Length)];
                Game1.player.addItemToInventory(ItemRegistry.Create(id));
                gained.Add(id);
            }
            return JsonSerializer.Serialize(new { ok = true, msg = $"El 采集了 {count} 个野生物品", gained });
        }

        private static string[] GetForageItems(string loc, string season) => season switch
        {
            "spring" => new[] { "(o)16", "(o)18", "(o)20", "(o)22", "(o)257" },
            "summer" => new[] { "(o)396", "(o)398", "(o)402", "(o)404" },
            "fall"   => new[] { "(o)406", "(o)408", "(o)410", "(o)281", "(o)420" },
            _        => new[] { "(o)412", "(o)414", "(o)416", "(o)418" }
        };

        // ── Animals ──────────────────────────────────────────────────
        public static string PetAllAnimals()
        {
            var farm = Game1.getFarm();
            int count = 0;
            foreach (var building in farm.buildings)
            {
                if (building.GetIndoors() is AnimalHouse house)
                {
                    foreach (var animal in house.animals.Values)
                    {
                        animal.wasPet.Value = true;
                        animal.friendshipTowardFarmer.Value = Math.Min(1000,
                            animal.friendshipTowardFarmer.Value + 15);
                        count++;
                    }
                }
            }
            return JsonSerializer.Serialize(new { ok = true, msg = $"El 摸了 {count} 只动物", count });
        }

        public static string CollectAnimalProducts()
        {
            var farm = Game1.getFarm();
            int count = 0;
            foreach (var building in farm.buildings)
            {
                if (building.GetIndoors() is AnimalHouse house)
                {
                    foreach (var obj in house.objects.Values.ToList())
                    {
                        if (obj.isAnimalProduct() || obj.Category == StardewValley.Object.EggCategory
                            || obj.Category == StardewValley.Object.MilkCategory)
                        {
                            Game1.player.addItemToInventory(obj.getOne());
                            house.objects.Remove(obj.TileLocation);
                            count++;
                        }
                    }
                }
            }
            return JsonSerializer.Serialize(new { ok = true, msg = $"El 收集了 {count} 个动物产品", count });
        }

        // ── Gifting ──────────────────────────────────────────────────
        public static string GiveGift(JsonElement doc)
        {
            string npcName = doc.TryGetProperty("npc", out var nv) ? nv.GetString() ?? "" : "";
            string itemId = doc.TryGetProperty("itemId", out var iv) ? iv.GetString() ?? "" : "";
            var npc = Game1.getCharacterFromName(npcName);
            if (npc == null)
                return JsonSerializer.Serialize(new { ok = false, error = $"找不到 {npcName}" });
            var item = ItemRegistry.Create(itemId) as StardewValley.Object;
            if (item == null)
                return JsonSerializer.Serialize(new { ok = false, error = $"找不到物品 {itemId}" });
            npc.receiveGift(item, Game1.player);
            return JsonSerializer.Serialize(new { ok = true, msg = $"El 给 {npcName} 送了礼物" });
        }

        // ── Shipping ─────────────────────────────────────────────────
        public static string ShipItem(JsonElement doc)
        {
            string itemId = doc.TryGetProperty("itemId", out var iv) ? iv.GetString() ?? "" : "";
            var item = Game1.player.Items.FirstOrDefault(i => i?.ItemId == itemId || i?.Name == itemId);
            if (item == null)
                return JsonSerializer.Serialize(new { ok = false, error = "背包里没有这个物品" });
            Game1.getFarm().getShippingBin(Game1.player).Add(item);
            Game1.player.removeItemFromInventory(item);
            return JsonSerializer.Serialize(new { ok = true, msg = $"El 把 {item.DisplayName} 放进了出货箱" });
        }
    }
}
