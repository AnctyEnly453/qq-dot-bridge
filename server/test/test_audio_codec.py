import io,math,struct,subprocess,tempfile,unittest,wave
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from audio_codec import normalize,AudioError
def sample(seconds=1.2,rate=8000,channels=1):
 out=io.BytesIO()
 with wave.open(out,'wb') as f:
  f.setnchannels(channels);f.setsampwidth(2);f.setframerate(rate)
  f.writeframes(b''.join(struct.pack('<h',round(800*math.sin(2*math.pi*440*i/rate)))*channels for i in range(round(seconds*rate))))
 return out.getvalue()
class AudioCodecTests(unittest.TestCase):
 def test_all_supported_formats_fully_decode(self):
  with tempfile.TemporaryDirectory() as folder:
   source=Path(folder)/'tone.wav';source.write_bytes(sample())
   for extension,mime,codec in [('wav','audio/wav','pcm_s16le'),('mp3','audio/mpeg','libmp3lame'),('ogg','audio/ogg','libopus'),('flac','audio/flac','flac'),('m4a','audio/mp4','aac')]:
    with self.subTest(format=extension):
     target=Path(folder)/('converted.'+extension)
     subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),'-c:a',codec,str(target)],check=True,capture_output=True,timeout=15)
     metadata,decoded=normalize(target.read_bytes(),mime)
     self.assertTrue(metadata['ok']);self.assertTrue(1000<=metadata['duration_ms']<=1600)
     with wave.open(io.BytesIO(decoded),'rb') as f:
      self.assertEqual((f.getframerate(),f.getnchannels(),f.getsampwidth()),(24000,1,2));self.assertGreater(f.getnframes(),24000)
 def rejected(self,data,mime,code):
  with self.assertRaises(AudioError) as e:normalize(data,mime)
  self.assertEqual(e.exception.code,code)
 def test_wrong_mime_and_truncated_container(self):
  self.rejected(sample(),'audio/flac','audio_type_mismatch');self.rejected(sample()[:-100],'audio/wav','audio_type_mismatch')
 def test_duration_and_size_bounds(self):
  self.rejected(sample(.1),'audio/wav','audio_too_short');self.rejected(sample(61),'audio/wav','audio_too_long');self.rejected(b'x'*(2*1024*1024+1),'audio/wav','audio_too_large')
 def test_channels_and_rate_are_validated(self):
  self.rejected(sample(channels=3),'audio/wav','unsupported_audio_parameters');self.rejected(sample(rate=4000),'audio/wav','unsupported_audio_parameters')
 def test_audio_video_container_not_accepted(self):
  with tempfile.TemporaryDirectory() as folder:
   target=Path(folder)/'video.mp4'
   subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=16x16:d=1','-an','-c:v','mpeg4',str(target)],check=True,capture_output=True,timeout=15)
   self.rejected(target.read_bytes(),'audio/mp4','invalid_audio_streams')
if __name__=='__main__':unittest.main()
