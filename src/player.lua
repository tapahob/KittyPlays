local mp = require 'mp'
local utils = require 'mp.utils'
local dir = os.getenv('KITTYPLAYS_SESSION_DIR')
mp.register_event('shutdown', function()
    if dir then
        for _, file in ipairs({'video.m3u8', 'audio.m3u8', 'master.m3u8'}) do
            os.remove(utils.join_path(dir, file))
        end
    end
end)

-- Post-live YouTube streams sometimes provide numbered, individually playable
-- MP4 segments without a seek index. Preserve the signed segment URLs and let
-- FFmpeg seek in a VOD playlist. Leave regular video and live streams alone.
local function archive_playlist(track, duration)
    if track.protocol ~= 'http_dash_segments' or not track.target_duration
        or track.target_duration <= 0 then return end
    local segments = track.fragments
    if type(segments) ~= 'table' or #segments < 2 or segments[1].duration then return end
    local sec = duration / #segments
    if math.abs(sec - track.target_duration) > track.target_duration * 0.05 then return end
    local lines = {'#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-TARGETDURATION:' .. math.ceil(math.max(sec, track.target_duration))}
    for _, part in ipairs(segments) do
        local url = part.url
        if type(url) ~= 'string' or url:find('[%c%s]') or
            not url:match('^https://[%w%.%-]+%.googlevideo%.com/') then return end
        lines[#lines+1] = string.format('#EXTINF:%.6f,', sec)
        lines[#lines+1] = url
    end
    lines[#lines+1] = '#EXT-X-ENDLIST'
    return table.concat(lines, '\n') .. '\n'
end

local function save(name, contents)
    local f = io.open(utils.join_path(dir, name), 'wb')
    if not f then return false end
    local ok = f:write(contents)
    return f:close() and ok
end

mp.add_hook('on_load', 15, function()
    if not dir then return end
    local result = mp.get_property_native('user-data/mpv/ytdl/json-subprocess-result')
    if not result or not result.stdout or not result.stdout:find('http_dash_segments',1,true) then return end
    local info = utils.parse_json(result.stdout)
    if not info or (info.live_status ~= 'post_live' and info.live_status ~= 'was_live')
        or not info.duration or info.duration <= 0 then return end
    local video, audio
    for _, track in ipairs(info.requested_formats or {}) do
        if track.vcodec == 'none' then audio = archive_playlist(track, info.duration)
        elseif track.acodec == 'none' then video = archive_playlist(track, info.duration) end
    end
    if not (video and audio) then return end
    local master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n'
        .. '#EXT-X-STREAM-INF:BANDWIDTH=' .. math.ceil((info.tbr or 10000)*1000)
        .. ',AUDIO="a"\nvideo.m3u8\n'
    if save('audio.m3u8', audio) and save('video.m3u8', video) and save('master.m3u8', master) then
        mp.set_property('file-local-options/demuxer-lavf-o', 'allowed_segment_extensions=ALL,allowed_extensions=ALL')
        mp.set_property('stream-open-filename', utils.join_path(dir, 'master.m3u8'))
    end
end)

local hud = mp.create_osd_overlay('ass-events')
local last_time, last_pts, last_drops, rate
local function reset()
    last_time, last_pts, last_drops, rate = nil, nil, nil, nil
end
mp.register_event('seek', reset)
mp.register_event('file-loaded', reset)
mp.observe_property('pause', 'bool', reset)
mp.register_event('end-file', function() reset(); hud:remove() end)
local function fps(n) return n and tostring(math.floor(n + 0.5)) or '—' end

mp.add_periodic_timer(0.5, function()
    if not mp.get_property_native('vo-configured') then return end
    local pts = mp.get_property_number('time-pos')
    local now = mp.get_time()
    local drops = mp.get_property_number('frame-drop-count', 0)
    local source = mp.get_property_number('container-fps')
    local filtered = mp.get_property_number('estimated-vf-fps')
    if mp.get_property_native('pause') or mp.get_property_native('paused-for-cache') then
        rate = 0
    elseif last_time and pts and last_pts and filtered then
        local dt = now - last_time
        local media = pts - last_pts
        if dt > 0 and media >= 0 and media <= dt * mp.get_property_number('speed', 1) + 0.25 then
            rate = math.max(0, (media * filtered - math.max(0, drops-last_drops)) / dt)
        else rate = nil end
    end
    last_time, last_pts, last_drops = now, pts, drops
    local line = '{\\an7\\pos(18,14)\\fs22\\bord2\\shad0}FPS  Исходный / текущий   ' .. fps(source) .. ' / ' .. fps(rate)
    if line ~= hud.data then hud.res_y = 720; hud.data = line; hud:update() end
end)
