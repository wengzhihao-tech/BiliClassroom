"""Local-only Vosk worker. JSONL protocol, explicit model path, no downloads."""
import sys,json,base64,time
from pathlib import Path
from vosk import Model,KaldiRecognizer,SetLogLevel
SetLogLevel(-1)
model_path=Path(sys.argv[1]).resolve()
if not (model_path/'am'/'final.mdl').is_file():
    raise RuntimeError('local model missing')
model=Model(str(model_path))
print(json.dumps({'type':'ready','engine':'vosk','protocol':1}),flush=True)
for line in sys.stdin:
    try:
        if len(line)>1500000:
            raise ValueError('request too large')
        request=json.loads(line)
        pcm=base64.b64decode(request['pcm'],validate=True)
        if not 2<=len(pcm)<=960000 or len(pcm)%2:
            raise ValueError('invalid PCM size')
        start=time.perf_counter()
        rec=KaldiRecognizer(model,16000)
        rec.SetWords(True)
        text=[]
        words=[]
        for offset in range(0,len(pcm),8000):
            if rec.AcceptWaveform(pcm[offset:offset+8000]):
                part=json.loads(rec.Result())
                text.append(part.get('text',''))
                words.extend(part.get('result',[]))
        final=json.loads(rec.FinalResult())
        text.append(final.get('text',''))
        words.extend(final.get('result',[]))
        if len(words)>256:
            raise ValueError('word quota exceeded')
        print(json.dumps({'type':'result','id':request['id'],'text':' '.join(t for t in text if t).strip(),'words':words,'elapsedMs':round((time.perf_counter()-start)*1000)},ensure_ascii=False),flush=True)
    except Exception as exc:
        print(json.dumps({'type':'error','id':request.get('id') if 'request' in locals() else None,'code':type(exc).__name__}),flush=True)