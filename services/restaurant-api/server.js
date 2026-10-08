import http from 'node:http';
import pg from 'pg';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
const port=Number(process.env.PORT||3001);
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':process.env.ALLOWED_ORIGIN||'*'});res.end(JSON.stringify(obj));};
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/healthz')return send(res,200,{status:'ok'});if(url.pathname==='/readyz'){await pool.query('SELECT 1');return send(res,200,{status:'ready'});}if(req.method==='GET'&&url.pathname==='/api/restaurants'){const r=await pool.query('SELECT * FROM restaurants ORDER BY id');return send(res,200,r.rows);}const match=url.pathname.match(/^\/api\/restaurants\/(\d+)\/menu$/);if(req.method==='GET'&&match){const r=await pool.query('SELECT * FROM menu_items WHERE restaurant_id=$1 ORDER BY id',[Number(match[1])]);return send(res,200,r.rows);}return send(res,404,{error:'Not found'});}catch(e){console.error(e);send(res,503,{error:'Service unavailable'});}}).listen(port,'0.0.0.0');
