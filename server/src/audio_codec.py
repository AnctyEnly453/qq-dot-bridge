"""Bounded local-file audio decoder. Existing FFmpeg only; no downloads/TTS."""
import io,json,os,struct,subprocess,sys,tempfile,wave,hashlib
MAX_BYTES=2*1024*1024;MAX_SECONDS=60;RATE=24000
FORMATS={'audio/wav':'wav','audio/mpeg':'mp3','audio/ogg':'ogg','audio/flac':'flac','audio/mp4':'mov'}
class AudioError(Exception):
 def __init__(self,code):self.code=code
def matches(data,mime):
 if mime=='audio/wav':return len(data)>=44 and data[:4]==b'RIFF' and data[8:12]==b'WAVE' and struct.unpack('<I',data[4:8])[0]+8==len(data)
 if mime=='audio/mpeg':return len(data)>=32 and (data[:3]==b'ID3' or data[0]==255 and data[1]&224==224)
 if mime=='audio/ogg':return len(data)>=28 and data[:4]==b'OggS'
 if mime=='audio/flac':return len(data)>=42 and data[:4]==b'fLaC'
 if mime=='audio/mp4':return len(data)>=32 and data[4:8]==b'ftyp'
 return False
def limits():
 if os.name!='posix':return
 import resource
 resource.setrlimit(resource.RLIMIT_CPU,(12,12));resource.setrlimit(resource.RLIMIT_AS,(768*1024*1024,768*1024*1024))
def execute(args,timeout=12):
 try:r=subprocess.run(args,capture_output=True,timeout=timeout,preexec_fn=limits if os.name=='posix' else None)
 except FileNotFoundError:raise AudioError('audio_unavailable')
 except subprocess.TimeoutExpired:raise AudioError('audio_processing_timeout')
 if r.returncode:raise AudioError('invalid_audio')
 return r.stdout
def normalize(data,mime,ffmpeg='ffmpeg',ffprobe='ffprobe'):
 if not data or mime not in FORMATS:raise AudioError('invalid_audio')
 if len(data)>MAX_BYTES:raise AudioError('audio_too_large')
 if not matches(data,mime):raise AudioError('audio_type_mismatch')
 demuxer=FORMATS[mime]
 with tempfile.TemporaryDirectory(prefix='dot-audio-decode-') as directory:
  path=os.path.join(directory,'source.audio');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data)
  options=['-protocol_whitelist','file,pipe','-f',demuxer]
  # MOV external data references are explicitly disabled. No playlists or URL
  # input are accepted, and no input filename/command option comes from clients.
  if demuxer=='mov':options+=['-enable_drefs','0','-use_absolute_path','0']
  output=execute([ffprobe,'-v','error','-max_alloc',str(16*1024*1024),*options,'-i',path,'-show_entries','format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels:stream_disposition=attached_pic','-of','json'])
  if len(output)>32768:raise AudioError('invalid_audio')
  try:info=json.loads(output);streams=info['streams'];audio=[s for s in streams if s.get('codec_type')=='audio']
  except (ValueError,KeyError,TypeError):raise AudioError('invalid_audio')
  if len(streams)>8 or len(audio)!=1 or any(s.get('codec_type')!='audio' and not(s.get('codec_type')=='video' and s.get('disposition',{}).get('attached_pic')==1) for s in streams):raise AudioError('invalid_audio_streams')
  stream=audio[0]
  try:channels=int(stream['channels']);rate=int(stream['sample_rate'])
  except (ValueError,KeyError,TypeError):raise AudioError('invalid_audio')
  if not 1<=channels<=2 or not 8000<=rate<=192000:raise AudioError('unsupported_audio_parameters')
  duration=info.get('format',{}).get('duration')
  if duration is not None:
   try:
    if float(duration)>MAX_SECONDS+0.05:raise AudioError('audio_too_long')
   except (ValueError,TypeError):raise AudioError('invalid_audio')
  pcm=execute([ffmpeg,'-hide_banner','-v','error','-xerror','-err_detect','explode','-max_alloc',str(16*1024*1024),'-threads','1','-filter_threads','1',*options,'-i',path,'-map','0:a:0','-vn','-sn','-dn','-t','61','-ar',str(RATE),'-ac','1','-c:a','pcm_s16le','-f','s16le','pipe:1'])
  if len(pcm)%2 or len(pcm)<RATE*2//5:raise AudioError('audio_too_short')
  if len(pcm)>RATE*2*MAX_SECONDS:raise AudioError('audio_too_long')
  duration_ms=round(len(pcm)*1000/(RATE*2));out=io.BytesIO()
  with wave.open(out,'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(RATE);f.writeframes(pcm)
  normalized=out.getvalue()
  return {'ok':True,'input_mime':mime,'input_bytes':len(data),'input_codec':stream.get('codec_name'),'input_sample_rate':rate,'input_channels':channels,'duration_ms':duration_ms,'output_mime':'audio/wav','output_sample_rate':RATE,'output_channels':1,'output_bytes':len(normalized),'output_sha256':hashlib.sha256(normalized).hexdigest()},normalized
def main():
 try:meta,data=normalize(sys.stdin.buffer.read(MAX_BYTES+1),sys.argv[1])
 except AudioError as e:meta,data={'ok':False,'error':e.code},b''
 except Exception:meta,data={'ok':False,'error':'invalid_audio'},b''
 encoded=json.dumps(meta,separators=(',',':')).encode();sys.stdout.buffer.write(struct.pack('>I',len(encoded))+encoded+data)
if __name__=='__main__':main()
