using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;

namespace ElCompanion
{
    internal class ChatInputMenu : IClickableMenu
    {
        private readonly TextBox _input;
        private readonly Action<string> _onSubmit;
        private bool _submitted;

        public ChatInputMenu(Action<string> onSubmit)
            : base(
                Game1.viewport.Width / 2 - 300,
                Game1.viewport.Height - 160,
                600, 72)
        {
            _onSubmit = onSubmit;

            _input = new TextBox(
                Game1.content.Load<Texture2D>("LooseSprites\\textBox"),
                null, Game1.smallFont, Color.Black)
            {
                X = xPositionOnScreen + 8,
                Y = yPositionOnScreen + 8,
                Width = width - 16,
                Text = ""
            };
            _input.OnEnterPressed += OnEnter;
            _input.Selected = true;
            Game1.keyboardDispatcher.Subscriber = _input;
        }

        private void OnEnter(TextBox sender)
        {
            if (_submitted) return;
            var text = sender.Text?.Trim();
            if (!string.IsNullOrEmpty(text))
            {
                _submitted = true;
                _onSubmit(text);
            }
            exitThisMenu();
        }

        public override void draw(SpriteBatch b)
        {
            // dim background
            b.Draw(Game1.fadeToBlackRect,
                new Rectangle(0, 0, Game1.viewport.Width, Game1.viewport.Height),
                Color.Black * 0.3f);

            b.DrawString(Game1.dialogueFont, "跟 El 说：",
                new Vector2(xPositionOnScreen + 8, yPositionOnScreen - 52), Color.White);

            drawTextureBox(b, xPositionOnScreen, yPositionOnScreen, width, height, Color.White);
            _input.Draw(b);
            drawMouse(b);
        }

        public override void receiveKeyPress(Keys key)
        {
            if (key == Keys.Escape) exitThisMenu();
        }

        public override void receiveLeftClick(int x, int y, bool playSound = true)
        {
            _input.SelectMe();
        }

        protected override void cleanupBeforeExit()
        {
            Game1.keyboardDispatcher.Subscriber = null;
        }
    }
}
