# Export + render a net diagram

## Export the structure
```bash
SD="${CLAUDE_PLUGIN_ROOT}/skills/agenticos-control/scripts"
bash "$SD/export-pnml.sh" <modelId> <sessionId> <netId>                 # -> ./<netId>.net.json (places/transitions/arcs + x/y)
bash "$SD/export-pnml.sh" <modelId> <sessionId> <netId> out.pnml --xml  # -> PNML XML
```
The JSON export shape is `{"net":{"places":{id:{id,label,x,y,tokens}},"transitions":{id:{id,label,x,y}},"arcs":{id:{id,source,target}}}}`.
Write output to the user's path (cwd by default), never inside the plugin.

## Render a dark diagram (matplotlib, no system deps beyond python)
The x/y in the export are screen coordinates (y grows downward — flip for plotting). Places are circles,
transitions are rounded rectangles, arcs are arrows. A minimal renderer:

```python
import json, sys, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyBboxPatch, FancyArrowPatch
d = json.load(open(sys.argv[1]))['net']; P,T,A = d['places'], d['transitions'], d['arcs']
xs=[n['x'] for n in list(P.values())+list(T.values())]; ys=[n['y'] for n in list(P.values())+list(T.values())]
ymax,ymin=max(ys),min(ys); ty=lambda y:(ymax+ymin)-y
pos={k:(v['x'],ty(v['y'])) for k,v in {**P,**T}.items()}
fig,ax=plt.subplots(figsize=(22,15),dpi=180); fig.patch.set_facecolor('#0d1117'); ax.set_facecolor('#0d1117'); ax.axis('off')
for a in A.values():
    if a['source'] in pos and a['target'] in pos:
        x1,y1=pos[a['source']]; x2,y2=pos[a['target']]
        ax.add_patch(FancyArrowPatch((x1,y1),(x2,y2),arrowstyle='-|>',mutation_scale=10,shrinkA=13,shrinkB=13,color='#30363d',lw=0.9))
for pid,p in P.items():
    x,y=pos[pid]; ax.add_patch(Circle((x,y),17,facecolor='#0b1f3a',edgecolor='#1f6feb',lw=1.4))
    ax.text(x,y-24,pid.replace('p-',''),ha='center',va='top',fontsize=5,color='#e6edf3')
for tid,t in T.items():
    x,y=pos[tid]; c='#a371f7' if tid.startswith('t-link-') else ('#2dd4bf' if tid.endswith('-tick') else '#f0883e')
    ax.add_patch(FancyBboxPatch((x-15,y-8),30,16,boxstyle='round,pad=1.5,rounding_size=4',facecolor=c,edgecolor=c,alpha=0.9))
    ax.text(x,y,tid.replace('t-',''),ha='center',va='center',fontsize=4.2,color='#0d1117',fontweight='bold')
ax.autoscale(); plt.tight_layout(); fig.savefig(sys.argv[2],facecolor='#0d1117',bbox_inches='tight'); print('wrote',sys.argv[2])
```
Save it and run: `python3 render.py <netId>.net.json <netId>.png` (needs `pip install matplotlib`, ideally in a
venv). Colour legend used above: cyan = scheduled tick (map), amber = command/action, purple = link
(knowledge-graph) transition, blue circle = place.

The GUI also has a built-in **Export Net Report (PDF)** / **Export PNG** in its workspace controls; that path
renders light and runs in the browser. Rendering from the JSON export as above gives full control (e.g. dark).
