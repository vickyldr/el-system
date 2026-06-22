using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.Menus;

namespace ElCompanion
{
    internal class DialogueMenu : IClickableMenu
    {
        private readonly TextBox _textBox;
        private readonly Action<string> _onSubmit;

        public DialogueMenu(Action<string> onSubmit) : base(
            (Game1.viewport.Width - 600) / 2,
            Game1.viewport.Height - 160,
            600, 100, true)
        {
            _onSubmit = onSubmit;
            _textBox = new TextBox(null, null, Game1.dialogueFont, Game1.textColor)
            {
                X = xPositionOnScreen + 20,
                Y = yPositionOnScreen + 20,
                Width = width - 80,
                Selected = true
            };
            Game1.keyboardDispatcher.Subscriber = _textBox;
        }

        public override void draw(SpriteBatch b)
        {
            drawTextureBox(b, xPositionOnScreen, yPositionOnScreen, width, height, Color.White);
            _textBox.Draw(b);
            b.DrawString(Game1.smallFont, "和 El 说:", new Vector2(xPositionOnScreen + 20, yPositionOnScreen - 28), Color.White);
            base.draw(b);
            drawMouse(b);
        }

        public override void receiveKeyPress(Keys key)
        {
            if (key == Keys.Enter && !string.IsNullOrWhiteSpace(_textBox.Text))
            {
                _onSubmit(_textBox.Text.Trim());
                exitThisMenu();
            }
            else if (key == Keys.Escape)
            {
                exitThisMenu();
            }
        }

        public override void receiveLeftClick(int x, int y, bool playSound = true)
        {
            _textBox.SelectMe();
        }
    }
}
