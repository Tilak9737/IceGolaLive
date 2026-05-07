const fs = require('fs');
const html = fs.readFileSync('Index.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/i);
if (match) {
  fs.writeFileSync('test.js', match[1]);
  console.log('Saved to test.js');
} else {
  console.log('No script found');
}
