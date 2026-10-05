# Converts dist-demo/index.html into the body-only file the Artifact publisher expects.
import re, sys
s = open('dist-demo/index.html', encoding='utf-8').read()
root = s.rindex('<div id="root">'); bs = s.rindex('<body>', 0, root); be = s.rindex('</body>')
hs = s.index('<head>') + 6; he = s.rindex('</head>', 0, bs)
head = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', '', s[hs:he], count=2)
t = re.search(r'<title>.*?</title>', head).group(0)
out = (t + '\n' + head.replace(t, '', 1).strip() + '\n' + s[bs + 6:be].strip() + '\n').replace('�', '\\uFFFD')
assert 'id="root"' in out
open(sys.argv[1], 'w', encoding='utf-8').write(out)
